import { randomBytes } from "node:crypto";
import type { HostAdapter, Observation } from "../core/adapter.ts";
import { type DeliveryResult, delivered, failed } from "../core/delivery.ts";
import type { Store } from "../core/store.ts";
import { isAlive } from "../util/ps.ts";

/**
 * Self-registered processes: anything that knows about modelbus can join without
 * modelbus knowing about it. `register` mints a token; the token is the process's
 * identity afterwards (CLI `--token`, RPC identity, or MODELBUS_TOKEN in the shim's
 * environment). Delivery is the process's choice: pull with `sync`, or a command
 * the daemon runs per message with the rendered text on stdin.
 *
 * Presence is last contact (any call) or, if a pid was given, that pid being alive.
 */

export interface RegisteredHandle {
  token: string;
  pid?: number;
  /** Shell command run per message; the text arrives on stdin. */
  deliver?: string;
}

const CONTACT_TIMEOUT_MS = 10 * 60 * 1000;

export class RegisteredAdapter implements HostAdapter {
  readonly host = "registered";
  /** Last time each token was presented. The tracker's own updates never touch this. */
  private readonly contact = new Map<string, number>();

  constructor(private readonly store: Store) {}

  touch(token: string): void {
    this.contact.set(token, Date.now());
  }

  /** Create the agent and return its token. `hostLabel` is free text shown in `who`. */
  register(opts: { name: string; hostLabel?: string; pid?: number; deliver?: string }) {
    const token = randomBytes(16).toString("base64url");
    this.contact.set(token, Date.now());
    const handle: RegisteredHandle = { token, pid: opts.pid, deliver: opts.deliver };
    const agent = this.store.bind({
      host: this.host,
      key: token,
      handle,
      durability: opts.pid ? "process" : "session",
      preferredName: opts.name,
      evidence: `self-registered${opts.hostLabel ? ` as ${opts.hostLabel}` : ""}`,
      attestation: "attested",
    });
    this.store.upsertPresence(agent.id, {
      pid: opts.pid,
      title: opts.hostLabel,
      relationship: "top-level",
      reachable: true,
      note: opts.deliver ? "delivered by running its command" : "pull: delivered on its next sync",
      startedAt: Date.now(),
    });
    return { agent, token };
  }

  /** Registered agents are live while they keep calling in (or their pid lives). */
  async observe(): Promise<Observation[]> {
    const out: Observation[] = [];
    for (const a of this.store.listAgents(["live", "gone"])) {
      if (a.host !== this.host) continue;
      const h = this.store.handleOf(a.id);
      if (!h) continue;
      const handle = JSON.parse(h.handle) as RegisteredHandle;
      const p = this.store.presenceOf(a.id);
      const last = this.contact.get(handle.token);
      const alive = handle.pid
        ? isAlive(handle.pid)
        : last !== undefined && Date.now() - last < CONTACT_TIMEOUT_MS;
      if (!alive) continue;
      out.push({
        handle,
        key: h.key,
        name: a.name,
        durability: handle.pid ? "process" : "session",
        relationship: "top-level",
        evidence: h.evidence,
        reachable: true,
        note: p?.note ?? undefined,
        pid: handle.pid,
        title: p?.title ?? undefined,
      });
    }
    return out;
  }

  handleFromKey(key: string): RegisteredHandle {
    const existing = this.store.handleByKey(this.host, key);
    return existing ? (JSON.parse(existing.handle) as RegisteredHandle) : { token: key };
  }

  async deliver(
    handle: unknown,
    text: string,
    _marker: string,
    onReceipt: () => void,
  ): Promise<DeliveryResult> {
    const h = handle as RegisteredHandle;
    if (!h.deliver) return { outcome: "waiting", detail: "pull" };
    const proc = Bun.spawn(["/bin/sh", "-c", h.deliver], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(text);
    proc.stdin.end();
    const code = await proc.exited;
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      return failed(`deliver command exit ${code}${err ? `: ${err.split("\n")[0]}` : ""}`);
    }
    onReceipt();
    return delivered("command");
  }
}
