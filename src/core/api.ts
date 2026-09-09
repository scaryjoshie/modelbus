import { EventEmitter } from "node:events";
import type { DeliveryResult } from "./delivery.ts";
import { GUARDS } from "./guards.ts";
import type { Agent, InboxItem, Message, Store } from "./store.ts";

/**
 * The bus API: the same handlers serve the CLI, the MCP shim, and any adapter.
 * Identity (`agentId`) is always resolved by the caller layer; the API never trusts
 * a name in params. Delivery is delegated through `deliver`, supplied by the daemon
 * (the tracker), so the API knows nothing about hosts.
 */

export type Deliver = (
  agent: Agent,
  text: string,
  marker: string,
  onReceipt: () => void,
) => Promise<DeliveryResult>;

export class ApiError extends Error {}

interface MessageEvent {
  conversationId: string;
  toIds: string[];
  message: Message;
}

export class Api {
  private readonly events = new EventEmitter();
  private deliver: Deliver = async () => ({ status: "queued", detail: "no push path" });
  /** conversation:replier pairs someone is currently blocked on inline. */
  private readonly waiting = new Set<string>();

  constructor(readonly store: Store) {
    this.events.setMaxListeners(1000);
  }

  setDeliver(fn: Deliver): void {
    this.deliver = fn;
  }

  resolveName(name: string): Agent {
    const a = this.store.agentByName(name);
    if (!a) throw new ApiError(`no agent named "${name}"; try who`);
    return a;
  }

  // ---- send ---------------------------------------------------------------

  async send(opts: {
    fromId: string;
    to: string;
    body: string;
    wait?: number;
  }): Promise<{ message: Message; to: Agent; delivery: DeliveryResult; reply?: InboxItem }> {
    const from = this.store.agentById(opts.fromId);
    if (!from) throw new ApiError("sender is not a known agent");
    const to = this.resolveName(opts.to);
    if (to.id === from.id) throw new ApiError("cannot send to yourself");
    if (Buffer.byteLength(opts.body, "utf8") > GUARDS.BODY_CAP_BYTES) {
      throw new ApiError(`body exceeds ${GUARDS.BODY_CAP_BYTES} bytes`);
    }
    if (!opts.body.trim()) throw new ApiError("empty body");
    const conv = this.store.dm(from.id, to.id);
    if (this.store.identicalRecently(conv.id, from.id, opts.body, GUARDS.DEDUPE_WINDOW_MS) > 0) {
      throw new ApiError("dropped: identical message sent within the last minute");
    }
    if (this.store.sendsSince(from.id, GUARDS.RATE_WINDOW_MS) >= GUARDS.RATE_LIMIT) {
      throw new ApiError(`refused: over ${GUARDS.RATE_LIMIT} sends per minute`);
    }
    const message = this.store.insertMessage(conv.id, from.id, opts.body);
    this.store.touch(from.id);
    this.events.emit("message", { conversationId: conv.id, toIds: [to.id], message });

    // A reply someone is blocked on inline is returned through that call, not also
    // pushed into their host (it would arrive twice).
    const delivery: DeliveryResult = this.waiting.has(`${conv.id}:${from.id}`)
      ? { status: "queued", detail: "returned inline to the waiting sender" }
      : await this.deliver(to, this.render(message, from), `#${message.id}`, () =>
          this.store.markReceived([message.id], to.id),
        );
    this.store.recordDelivery(message.id, to.id, delivery);

    const reply =
      opts.wait && opts.wait > 0
        ? await this.waitForReply(from.id, to, conv.id, message.seq, opts.wait)
        : undefined;
    return { message, to, delivery, reply };
  }

  /** Text handed to a host when a message is queued into it: one line of attribution. */
  render(message: Message, from: Agent): string {
    return `[modelbus #${message.id}] from ${from.name}\n\n${message.body}`;
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
      this.store.markReceived([m.id], meId);
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

  async pull(opts: {
    agentId: string;
    scope?: string;
    wait?: number;
    limit?: number;
  }): Promise<{ items: InboxItem[]; more: number; moreElsewhere: number }> {
    const me = this.store.agentById(opts.agentId);
    if (!me) throw new ApiError("unknown agent");
    this.store.touch(me.id);
    const limit = Math.min(opts.limit ?? GUARDS.PULL_LIMIT, GUARDS.PULL_LIMIT);
    const conversationId = opts.scope
      ? this.store.dm(me.id, this.resolveName(opts.scope).id).id
      : undefined;

    const take = () => {
      const items = this.store.inbox(me.id, { conversationId, limit });
      this.store.markReceived(
        items.map((i) => i.id),
        me.id,
      );
      const more = this.store.countUnreceived(me.id, conversationId);
      const moreElsewhere = conversationId ? this.store.countUnreceived(me.id) - more : 0;
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
    const deadline = Math.min(waitSeconds, GUARDS.MAX_WAIT_SECONDS) * 1000;
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

  log(opts: { a?: string; b?: string }) {
    const conversationId =
      opts.a && opts.b
        ? this.store.dm(this.resolveName(opts.a).id, this.resolveName(opts.b).id).id
        : undefined;
    return this.store.log(conversationId);
  }
}
