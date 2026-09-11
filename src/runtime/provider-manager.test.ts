import { describe, expect, test } from "bun:test";
import type { Outbound } from "../core/delivery.ts";
import type { Agent } from "../core/store.ts";
import { Store } from "../core/store.ts";
import type { Watch } from "../util/watch.ts";
import { discover } from "./discovery.ts";
import type { Observation, Provider } from "./provider.ts";
import { ProviderManager } from "./provider-manager.ts";

class FakeHost implements Provider {
  readonly name = "fake";
  readonly discovery = { observe: async () => this.live };
  readonly connector = { deliver: this.deliver.bind(this) };
  live: Observation[] = [];
  delivered: Array<{ key: string; body: string }> = [];
  /** Set to hand the manager a watch with each delivery. */
  watch: Watch | undefined;
  async deliver(key: string, o: Outbound, onRead: () => void) {
    this.delivered.push({ key, body: o.message.body });
    onRead();
    return { result: { status: "delivered" as const }, watch: this.watch };
  }
}

/** A message from `from` as core would hand it over; nothing here is stored. */
function outbound(from: Agent, body: string): Outbound {
  return {
    message: { seq: 1, id: "m1", conversationId: "c1", fromAgentId: from.id, body, createdAt: 0 },
    from,
    conversation: { id: "c1", kind: "dm", key: "dm:c1", name: null, createdAt: 0 },
  };
}

function obs(key: string, name: string, extra: Partial<Observation> = {}): Observation {
  return { key, name, relationship: "top-level", reachable: true, ...extra };
}

function setup() {
  const store = new Store(":memory:");
  const host = new FakeHost();
  return { store, host, t: new ProviderManager(store, [host]) };
}

describe("provider manager", () => {
  test("discovery can run without binding agents or invoking other capabilities", async () => {
    const { store, host } = setup();
    host.live = [obs("k1", "one")];
    const provider: Provider = {
      name: host.name,
      discovery: host.discovery,
      configure: () => {
        throw new Error("discovery must not configure");
      },
      identifySelf: async () => {
        throw new Error("discovery must not identify the caller");
      },
      connector: {
        deliver: async () => {
          throw new Error("discovery must not deliver");
        },
      },
    };
    expect(await discover([provider])).toEqual([
      { provider: "fake", status: "observed", observations: host.live },
    ]);
    expect(store.listAgents()).toEqual([]);
    store.close();
  });

  test("a connector-only provider can receive without discovery", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const provider: Provider = { name: host.name, connector: host.connector };
    const manager = new ProviderManager(store, [provider]);
    const agent = manager.register({ provider: host.name, key: "direct", name: "direct" });
    await manager.reconcile();
    expect(await discover([provider])).toEqual([]);
    expect(manager.list().map((a) => a.id)).toEqual([agent.id]);
    expect((await manager.deliver(agent, outbound(agent, "hello"), () => {})).status).toBe(
      "delivered",
    );
    expect(host.delivered).toEqual([{ key: "direct", body: "hello" }]);
    store.close();
  });

  test("failed discovery is distinguishable from an empty observation", async () => {
    const results = await discover([
      {
        name: "broken",
        discovery: {
          observe: async () => {
            throw new Error("unavailable");
          },
        },
      },
      { name: "empty", discovery: { observe: async () => [] } },
    ]);
    expect(results).toEqual([
      { provider: "broken", status: "failed", detail: "unavailable" },
      { provider: "empty", status: "observed", observations: [] },
    ]);
  });

  test("observations are candidates, not agents; registering one makes the agent", async () => {
    const { store, host, t } = setup();
    host.live = [obs("k1", "one"), obs("k2", "two")];
    await t.reconcile();
    expect(t.list()).toEqual([]); // nothing is on the bus yet
    expect(
      t
        .candidates()
        .map((c) => c.name)
        .sort(),
    ).toEqual(["one", "two"]);
    expect(store.listAgents()).toEqual([]);

    const c = t.candidateNamed("one");
    if (!c) throw new Error("candidate missing");
    const one = t.register(c);
    expect(t.list().map((e) => e.name)).toEqual(["one"]);
    expect(t.candidates().map((c) => c.name)).toEqual(["two"]); // still only a candidate
    expect(t.list()[0]?.reachable).toBe(true); // presence comes from the observation

    // the same key stays the same agent, and its name follows the host until pinned
    host.live = [obs("k1", "one renamed by host"), obs("k2", "two")];
    await t.reconcile();
    expect(t.list().map((e) => e.name)).toEqual(["one renamed by host"]);
    expect(t.list()[0]?.id).toBe(one.id);
    store.rename(one.id, "pinned");
    host.live = [obs("k1", "one again"), obs("k2", "two")];
    await t.reconcile();
    expect(t.list()[0]?.name).toBe("pinned");
  });

  test("subagents are never candidates", async () => {
    const { host, t } = setup();
    host.live = [obs("root", "root"), obs("child", "child", { relationship: "subagent" })];
    await t.reconcile();
    expect(t.candidates().map((c) => c.name)).toEqual(["root"]);
  });

  test("attach reaches the provider by key whether or not the session registered", async () => {
    const store = new Store(":memory:");
    const info: Array<{ key: string; token: unknown }> = [];
    const p: Provider = {
      name: "attachable",
      connector: {
        deliver: async () => ({ result: { status: "delivered" as const } }),
        attach: (key, i) => info.push({ key, token: i.token }),
      },
    };
    const t = new ProviderManager(store, [p]);
    expect(t.attach({ provider: "attachable", key: "s1" }, { token: "t" })).toBe(true);
    expect(t.attach({ provider: "nowhere", key: "s1" }, { token: "t" })).toBe(false);
    expect(info).toEqual([{ key: "s1", token: "t" }]);
    store.close();
  });

  test("deliver hands the provider the key it observed", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    const c = t.candidateNamed("one");
    if (!c) throw new Error("candidate missing");
    const agent = t.register(c);
    let read = false;
    const result = await t.deliver(agent, outbound(agent, "hello"), () => {
      read = true;
    });
    expect(result.status).toBe("delivered");
    expect(read).toBe(true);
    expect(host.delivered).toEqual([{ key: "k1", body: "hello" }]);
  });

  test("an agent nobody observes is live while it calls in", async () => {
    const { t } = setup();
    const a = t.register({ provider: "elsewhere", key: "x", name: "lonely" });
    expect(t.list().map((e) => `${e.name}:${e.note}`)).toEqual(["lonely:by sync"]);
    const result = await t.deliver(a, outbound(a, "hi"), () => undefined);
    expect(result.status).toBe("sent");
  });

  test("a session registering itself binds to its observed key, not a new one", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    expect(t.agentFor({ provider: "fake", key: "k1" })).toBeUndefined();
    const a = t.register({ provider: "fake", key: "k1", name: "one" });
    expect(t.agentFor({ provider: "fake", key: "k1" })?.id).toBe(a.id);
    expect(t.list()[0]?.id).toBe(a.id);
    expect(t.list()).toHaveLength(1);
    expect(t.candidates()).toEqual([]);
  });

  test("the manager owns watches: drops finished ones, closes the rest on stop", async () => {
    const { store, host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    t.register({ provider: "fake", key: "k1", name: "one" }); // observed sessions register to be on the bus
    const a = store.agentByName("one");
    if (!a) throw new Error("agent missing");

    let finish: () => void = () => undefined;
    let closed = 0;
    const finishes: Watch = {
      done: new Promise((r) => {
        finish = r;
      }),
      [Symbol.dispose]: () => closed++,
    };
    const lingers: Watch = { done: new Promise(() => {}), [Symbol.dispose]: () => closed++ };

    host.watch = finishes;
    await t.deliver(a, outbound(a, "one"), () => undefined);
    host.watch = lingers;
    await t.deliver(a, outbound(a, "two"), () => undefined);
    expect(t.watching).toBe(2);

    finish();
    await Promise.resolve();
    expect(t.watching).toBe(1);

    t.stop();
    expect(closed).toBe(1); // only the lingering watch needed closing
    expect(t.watching).toBe(0);
  });

  test("ready() settles after the first pass; the roster is complete by then", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    t.register({ provider: "fake", key: "k1", name: "one" }); // observed sessions register to be on the bus
    t.start(60_000);
    try {
      expect(t.list()[0]?.note).toBe("by sync"); // the first pass has not finished yet
      await t.ready();
      expect(t.list().map((e) => e.name)).toEqual(["one"]);
      expect(t.list()[0]?.note).toBeUndefined(); // now observed
    } finally {
      t.stop();
    }
  });

  test("onReachable fires once when an agent becomes reachable, not while it stays so", async () => {
    const { host, t } = setup();
    const seen: string[] = [];
    t.onReachable = async (a, host) => {
      seen.push(`${a.name}${host.queueSurvivesRestart ? "" : ":dropsQueue"}`);
    };
    host.live = [obs("k1", "one", { reachable: false, note: "no turns yet" })];
    t.register({ provider: "fake", key: "k1", name: "one" }); // observed sessions register to be on the bus
    await t.reconcile();
    expect(seen).toEqual([]); // present but not reachable

    host.live = [obs("k1", "one")];
    await t.reconcile();
    await t.reconcile();
    expect(seen).toEqual(["one"]); // once, not on every pass

    host.live = [obs("k1", "one", { reachable: false, note: "restarting" })];
    await t.reconcile();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    expect(seen).toEqual(["one", "one"]); // unreachable and back: again
  });

  test("onReachable carries the provider's statement about its host's queue", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const drops: Provider = {
      name: "drops",
      discovery: { observe: async () => [obs("k", "codexish")] },
      connector: { queueSurvivesRestart: false, deliver: host.deliver.bind(host) },
    };
    const t = new ProviderManager(store, [drops]);
    const seen: string[] = [];
    t.onReachable = async (a, h) => {
      seen.push(`${a.name}:${h.queueSurvivesRestart}`);
    };
    t.register({ provider: "drops", key: "k", name: "codexish" });
    await t.reconcile();
    expect(seen).toEqual(["codexish:false"]);
    store.close();
  });

  test("an agent's own status shows when its host reports none; contact is its activity", () => {
    const { host, t } = setup();
    const lonely = t.register({ provider: "elsewhere", key: "x", name: "lonely" });
    t.setStatus(lonely.id, "  indexing the repo ");
    const before = Date.now();
    const entry = t.list().find((e) => e.id === lonely.id);
    expect(entry?.status).toBe("indexing the repo");
    expect(entry?.activeAt).toBeGreaterThanOrEqual(before - 1000);
    t.setStatus(lonely.id, "");
    expect(t.list().find((e) => e.id === lonely.id)?.status).toBeUndefined();
    // a host's own status wins over the agent's
    host.live = [obs("k1", "one", { status: "busy", activeAt: 42 })];
    t.register({ provider: "fake", key: "k1", name: "one" });
    return t.reconcile().then(() => {
      const one = t.list().find((e) => e.name === "one");
      if (!one) throw new Error("agent missing");
      t.setStatus(one.id, "mine");
      expect(t.list().find((e) => e.name === "one")?.status).toBe("busy");
      expect(t.list().find((e) => e.name === "one")?.activeAt).toBe(42);
    });
  });

  test("notify goes through the provider's own door, or says it cannot", async () => {
    const store = new Store(":memory:");
    const lines: string[] = [];
    const talkative: Provider = {
      name: "talks",
      connector: {
        deliver: async () => ({ result: { status: "delivered" as const } }),
        notify: async (_key, text) => {
          lines.push(text);
          return { status: "delivered" as const };
        },
      },
    };
    const mute: Provider = {
      name: "mute",
      connector: { deliver: async () => ({ result: { status: "delivered" as const } }) },
    };
    const t = new ProviderManager(store, [talkative, mute]);
    const a = t.register({ provider: "talks", key: "k", name: "a" });
    const b = t.register({ provider: "mute", key: "k", name: "b" });
    expect((await t.notify(a, "hello")).status).toBe("delivered");
    expect(lines).toEqual(["hello"]);
    expect((await t.notify(b, "hello")).status).toBe("sent");
    store.close();
  });

  test("a failing provider keeps its last presence", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    t.register({ provider: "fake", key: "k1", name: "one" }); // observed sessions register to be on the bus
    host.discovery.observe = async () => {
      throw new Error("host down");
    };
    await t.reconcile();
    expect(t.list().map((e) => e.name)).toEqual(["one"]);
  });
});
