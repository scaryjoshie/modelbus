import { EventEmitter } from "node:events";
import type { DeliveryResult, DeliveryStatus, Outbound } from "./delivery.ts";
import { DEFAULT_LIMITS, type Limits } from "./limits.ts";
import type {
  Agent,
  Conversation,
  ConversationOverview,
  InboxItem,
  Message,
  Store,
} from "./store.ts";

/**
 * The bus API: the runtime invokes the same handlers for every client.
 * Agents and conversations are addressed by id only. The caller layer resolves
 * identity and display names (`reviewer`, `#backend`) before calling in.
 * Delivery is delegated through `deliver`, supplied by the daemon (the provider
 * manager), so the API knows nothing about host implementations.
 */

export type Deliver = (
  to: Agent,
  outbound: Outbound,
  onRead: () => void,
) => Promise<DeliveryResult>;

export class ApiError extends Error {}

interface MessageEvent {
  conversationId: string;
  toIds: string[];
  message: Message;
}

/** What a send produced: one result per recipient. */
export interface SendResult {
  message: Message;
  conversation: Conversation;
  deliveries: Array<{ to: Agent } & DeliveryResult>;
  reply?: InboxItem;
}

export class Api {
  private readonly events = new EventEmitter();
  private deliver: Deliver = async () => ({ status: "sent", detail: "no push path" });
  /** conversation:agent pairs currently blocked inline waiting for a reply. */
  private readonly waiting = new Set<string>();
  /** Message ids with a push in flight, so a retry never pushes one twice. */
  private readonly pushing = new Set<string>();
  readonly limits: Limits;

  constructor(
    readonly store: Store,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.events.setMaxListeners(1000);
  }

  setDeliver(fn: Deliver): void {
    this.deliver = fn;
  }

  // ---- send ---------------------------------------------------------------

  /** Send into a conversation the sender belongs to; each other member gets a copy. */
  async send(opts: {
    fromId: string;
    conversationId: string;
    body: string;
    wait?: number;
  }): Promise<SendResult> {
    const from = this.store.agentById(opts.fromId);
    if (!from) throw new ApiError("sender is not a known agent");
    const conversation = this.store.conversationById(opts.conversationId);
    if (!conversation) throw new ApiError("unknown conversation");
    const members = this.store.participants(conversation.id);
    if (!members.includes(from.id)) throw new ApiError("sender is not in this conversation");
    const { bodyCapBytes, dedupeWindowMs, rateLimit, rateWindowMs } = this.limits;
    if (Buffer.byteLength(opts.body, "utf8") > bodyCapBytes) {
      throw new ApiError(`body exceeds ${bodyCapBytes} bytes`);
    }
    if (!opts.body.trim()) throw new ApiError("empty body");
    if (this.store.identicalRecently(conversation.id, from.id, opts.body, dedupeWindowMs) > 0) {
      throw new ApiError("dropped: identical message sent within the last minute");
    }
    if (this.store.sendsSince(from.id, rateWindowMs) >= rateLimit) {
      throw new ApiError(`refused: over ${rateLimit} sends per ${rateWindowMs / 1000}s`);
    }
    const message = this.store.insertMessage(conversation.id, from.id, opts.body);
    this.store.touch(from.id);
    const toIds = members.filter((id) => id !== from.id);
    this.events.emit("message", { conversationId: conversation.id, toIds, message });

    const deliveries: SendResult["deliveries"] = [];
    for (const toId of toIds) {
      const to = this.store.agentById(toId);
      if (!to) continue;
      // A recipient blocked inline waiting in this conversation gets the message
      // through that call, not also pushed into its host (it would arrive twice).
      let result: DeliveryResult;
      if (this.waiting.has(`${conversation.id}:${to.id}`)) {
        result = { status: "delivered", detail: "returned inline to the waiting recipient" };
        this.store.recordDelivery(message.id, to.id, result);
      } else {
        result = await this.push(to, { message, from, conversation });
      }
      deliveries.push({ to, ...result });
    }

    const reply =
      opts.wait && opts.wait > 0
        ? await this.waitForReply(from.id, conversation.id, message.seq, opts.wait)
        : undefined;
    return { message, conversation, deliveries, reply };
  }

  /** One push through the delivery port, with its result recorded. */
  private async push(to: Agent, outbound: Outbound): Promise<DeliveryResult> {
    const id = outbound.message.id;
    this.pushing.add(id);
    try {
      const result = await this.deliver(to, outbound, () => this.store.markRead([id], to.id));
      this.store.recordDelivery(id, to.id, result);
      return result;
    } finally {
      this.pushing.delete(id);
    }
  }

  /**
   * Push everything still waiting for an agent: sent but never delivered, or the
   * push failed. The runtime calls this when the agent becomes reachable; core
   * does not know why. Messages already delivered are left alone unless the
   * caller says the host lost them (`includeDelivered`), since otherwise the
   * host may still hold its copy.
   */
  async redeliver(
    agentId: string,
    opts: { includeDelivered?: boolean } = {},
  ): Promise<{ delivered: number; failed: number; waiting: number }> {
    const to = this.store.agentById(agentId);
    if (!to) throw new ApiError("unknown agent");
    const counts = { delivered: 0, failed: 0, waiting: 0 };
    const states: DeliveryStatus[] = opts.includeDelivered
      ? ["sent", "failed", "delivered"]
      : ["sent", "failed"];
    for (const outbound of this.store.unread(to.id, states)) {
      if (this.pushing.has(outbound.message.id)) continue;
      const r = await this.push(to, outbound);
      counts[r.status === "sent" ? "waiting" : r.status]++;
    }
    return counts;
  }

  /** The next message in the conversation from anyone but me, after `afterSeq`. */
  private async waitForReply(
    meId: string,
    conversationId: string,
    afterSeq: number,
    waitSeconds: number,
  ): Promise<InboxItem | undefined> {
    const take = (): InboxItem | undefined => {
      const [m] = this.store.repliesAfter(conversationId, meId, afterSeq);
      if (!m) return undefined;
      this.store.markRead([m.id], meId);
      const from = this.store.agentById(m.fromAgentId);
      return { ...m, fromName: from?.name ?? "?", fromProvider: from?.provider ?? "?" };
    };
    const first = take();
    if (first) return first;
    const key = `${conversationId}:${meId}`;
    this.waiting.add(key);
    try {
      await this.awaitEvent(
        (ev) => ev.conversationId === conversationId && ev.message.fromAgentId !== meId,
        waitSeconds,
      );
    } finally {
      this.waiting.delete(key);
    }
    return take();
  }

  // ---- pull (sync) --------------------------------------------------------

  /** `conversationId` limits the read to one conversation. */
  async pull(opts: {
    agentId: string;
    conversationId?: string;
    wait?: number;
    limit?: number;
  }): Promise<{ items: InboxItem[]; more: number; moreElsewhere: number }> {
    const me = this.store.agentById(opts.agentId);
    if (!me) throw new ApiError("unknown agent");
    this.store.touch(me.id);
    const limit = Math.min(opts.limit ?? this.limits.pullLimit, this.limits.pullLimit);
    const conversationId = opts.conversationId;

    const take = () => {
      const items = this.store.inbox(me.id, { conversationId, limit });
      this.store.markRead(
        items.map((i) => i.id),
        me.id,
      );
      const more = this.store.countUnread(me.id, conversationId);
      const moreElsewhere = conversationId ? this.store.countUnread(me.id) - more : 0;
      return { items, more, moreElsewhere };
    };
    const first = take();
    if (first.items.length || !opts.wait) return first;
    await this.awaitEvent(
      (ev) => ev.toIds.includes(me.id) && (!conversationId || ev.conversationId === conversationId),
      opts.wait,
    );
    return take();
  }

  /** Resolve when a matching message event fires or the wait elapses. */
  private awaitEvent(match: (ev: MessageEvent) => boolean, waitSeconds: number): Promise<void> {
    const deadline = Math.min(waitSeconds, this.limits.maxWaitSeconds) * 1000;
    return new Promise((resolve) => {
      const onMessage = (ev: MessageEvent) => {
        if (!match(ev)) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, deadline);
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("message", onMessage);
      };
      this.events.on("message", onMessage);
    });
  }

  // ---- groups, names, reading ---------------------------------------------

  /** The group with this name (created if missing) after adding and removing members. */
  group(opts: { name: string; add?: string[]; remove?: string[] }): {
    conversation: Conversation;
    members: string[];
  } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(opts.name)) {
      throw new ApiError("group names are letters, digits, dot, dash, underscore; up to 64");
    }
    const conversation = this.store.group(opts.name);
    const members = this.store.setMembers(conversation.id, opts);
    return { conversation, members };
  }

  /** A person pins a new name on an agent; the old name stays as an alias. */
  rename(agentId: string, name: string): Agent {
    if (!name.trim() || name.includes("\n") || name.startsWith("#")) {
      throw new ApiError("a name is one line and does not start with #");
    }
    const agent = this.store.rename(agentId, name.trim());
    if (!agent) throw new ApiError(`name "${name}" is taken`);
    return agent;
  }

  /** One line saying what an agent is for; empty clears it. */
  describe(agentId: string, purpose: string): Agent {
    const line = purpose.trim().split("\n")[0] ?? "";
    const agent = this.store.setPurpose(agentId, line === "" ? null : line);
    if (!agent) throw new ApiError("unknown agent");
    return agent;
  }

  /** Every conversation, for a person looking at the chats. */
  conversations(): ConversationOverview[] {
    return this.store.conversationsOverview();
  }

  /** A page of one conversation, newest last. */
  history(opts: { conversationId: string; beforeSeq?: number; limit?: number }): InboxItem[] {
    if (!this.store.conversationById(opts.conversationId))
      throw new ApiError("unknown conversation");
    const limit = Math.min(opts.limit ?? this.limits.pullLimit, this.limits.pullLimit);
    return this.store.history(opts.conversationId, { beforeSeq: opts.beforeSeq, limit });
  }

  /** Every message with delivery state, or only one conversation's. */
  log(opts: { conversationId?: string }) {
    return this.store.log(opts.conversationId);
  }
}
