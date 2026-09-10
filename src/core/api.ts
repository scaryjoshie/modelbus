import { EventEmitter } from "node:events";
import type { DeliveryResult, Outbound } from "./delivery.ts";
import { DEFAULT_LIMITS, type Limits } from "./limits.ts";
import type { Agent, InboxItem, Message, Store } from "./store.ts";

/**
 * The bus API: the runtime invokes the same handlers for every client.
 * Agents are addressed by id only. The caller layer resolves identity and any
 * display names before calling in. Delivery is delegated through `deliver`,
 * supplied by the daemon (the provider manager), so the API knows nothing about
 * host implementations.
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

export class Api {
  private readonly events = new EventEmitter();
  private deliver: Deliver = async () => ({ status: "sent", detail: "no push path" });
  /** conversation:replier pairs someone is currently blocked on inline. */
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

  async send(opts: {
    fromId: string;
    toId: string;
    body: string;
    wait?: number;
  }): Promise<{ message: Message; to: Agent; delivery: DeliveryResult; reply?: InboxItem }> {
    const from = this.store.agentById(opts.fromId);
    if (!from) throw new ApiError("sender is not a known agent");
    const to = this.store.agentById(opts.toId);
    if (!to) throw new ApiError("recipient is not a known agent");
    if (to.id === from.id) throw new ApiError("cannot send to yourself");
    const { bodyCapBytes, dedupeWindowMs, rateLimit, rateWindowMs } = this.limits;
    if (Buffer.byteLength(opts.body, "utf8") > bodyCapBytes) {
      throw new ApiError(`body exceeds ${bodyCapBytes} bytes`);
    }
    if (!opts.body.trim()) throw new ApiError("empty body");
    const conv = this.store.dm(from.id, to.id);
    if (this.store.identicalRecently(conv.id, from.id, opts.body, dedupeWindowMs) > 0) {
      throw new ApiError("dropped: identical message sent within the last minute");
    }
    if (this.store.sendsSince(from.id, rateWindowMs) >= rateLimit) {
      throw new ApiError(`refused: over ${rateLimit} sends per ${rateWindowMs / 1000}s`);
    }
    const message = this.store.insertMessage(conv.id, from.id, opts.body);
    this.store.touch(from.id);
    this.events.emit("message", { conversationId: conv.id, toIds: [to.id], message });

    // A reply someone is blocked on inline is returned through that call, not also
    // pushed into their host (it would arrive twice).
    let delivery: DeliveryResult;
    if (this.waiting.has(`${conv.id}:${from.id}`)) {
      delivery = { status: "delivered", detail: "returned inline to the waiting sender" };
      this.store.recordDelivery(message.id, to.id, delivery);
    } else {
      delivery = await this.push(to, { message, from });
    }

    const reply =
      opts.wait && opts.wait > 0
        ? await this.waitForReply(from.id, to, conv.id, message.seq, opts.wait)
        : undefined;
    return { message, to, delivery, reply };
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
   * does not know why. Messages already delivered are left alone: the host may
   * still hold its copy.
   */
  async redeliver(
    agentId: string,
  ): Promise<{ delivered: number; failed: number; waiting: number }> {
    const to = this.store.agentById(agentId);
    if (!to) throw new ApiError("unknown agent");
    const counts = { delivered: 0, failed: 0, waiting: 0 };
    for (const outbound of this.store.undelivered(to.id)) {
      if (this.pushing.has(outbound.message.id)) continue;
      const r = await this.push(to, outbound);
      counts[r.status === "sent" ? "waiting" : r.status]++;
    }
    return counts;
  }

  private async waitForReply(
    meId: string,
    from: Agent,
    conversationId: string,
    afterSeq: number,
    waitSeconds: number,
  ): Promise<InboxItem | undefined> {
    const take = (): InboxItem | undefined => {
      const [m] = this.store.repliesAfter(conversationId, from.id, afterSeq);
      if (!m) return undefined;
      this.store.markRead([m.id], meId);
      return { ...m, fromName: from.name, fromHost: from.host };
    };
    const first = take();
    if (first) return first;
    const key = `${conversationId}:${from.id}`;
    this.waiting.add(key);
    try {
      await this.awaitEvent(
        (ev) => ev.conversationId === conversationId && ev.message.fromAgentId === from.id,
        waitSeconds,
      );
    } finally {
      this.waiting.delete(key);
    }
    return take();
  }

  // ---- pull (sync) --------------------------------------------------------

  /** `scopeId` limits the read to the DM with that agent. */
  async pull(opts: {
    agentId: string;
    scopeId?: string;
    wait?: number;
    limit?: number;
  }): Promise<{ items: InboxItem[]; more: number; moreElsewhere: number }> {
    const me = this.store.agentById(opts.agentId);
    if (!me) throw new ApiError("unknown agent");
    this.store.touch(me.id);
    const limit = Math.min(opts.limit ?? this.limits.pullLimit, this.limits.pullLimit);
    const conversationId = opts.scopeId ? this.store.dm(me.id, opts.scopeId).id : undefined;

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

  // ---- log ----------------------------------------------------------------

  /** Every message, or only the DM between two agent ids. */
  log(opts: { between?: [string, string] }) {
    const conversationId = opts.between ? this.store.dm(...opts.between).id : undefined;
    return this.store.log(conversationId);
  }
}
