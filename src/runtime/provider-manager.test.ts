import { describe, expect, test } from "bun:test";
import type { Outbound } from "../core/delivery.ts";
import type { Agent } from "../core/store.ts";
import { Store } from "../core/store.ts";
import type { Watch } from "../util/watch.ts";
import { discover } from "./discovery.ts";
import type { Observation, Provider } from "./provider.ts";
import { ProviderManager } from "./provider-manager.ts";

class FakeHost implements Provider {
  readonly host = "fake";
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
      host: host.host,
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
      { host: "fake", status: "observed", observations: host.live },
    ]);
    expect(store.listAgents()).toEqual([]);
    store.close();
  });

  test("a connector-only provider can receive without discovery", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const provider: Provider = { host: host.host, connector: host.connector };
    const manager = new ProviderManager(store, [provider]);
    const agent = manager.identify({ host: host.host, key: "direct", name: "direct" });
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
        host: "broken",
        discovery: {
          observe: async () => {
            throw new Error("unavailable");
          },
        },
      },
      { host: "empty", discovery: { observe: async () => [] } },
    ]);
    expect(results).toEqual([
      { host: "broken", status: "failed", detail: "unavailable" },
      { host: "empty", status: "observed", observations: [] },
    ]);
  });

  test("observations become agents; the same key stays the same agent across passes", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one"), obs("k2", "two")];
    await t.reconcile();
    const first = t.list();
    expect(first.map((e) => e.name).sort()).toEqual(["one", "two"]);
    const idOne = first.find((e) => e.name === "one")?.id;

    host.live = [obs("k1", "one renamed by host")];
    await t.reconcile();
    const second = t.list();
    expect(second.map((e) => e.name)).toEqual(["one renamed by host"]); // follows the host
    expect(second[0]?.id).toBe(idOne); // but the id is ours and never changes

    host.live = [obs("k1", "one"), obs("k2", "two")];
    await t.reconcile();
    expect(t.list().find((e) => e.name === "two")?.id).toBe(
      first.find((e) => e.name === "two")?.id,
    );
  });

  test("subagents never become peers", async () => {
    const { host, t } = setup();
    host.live = [obs("root", "root"), obs("child", "child", { relationship: "subagent" })];
    await t.reconcile();
    expect(t.list().map((e) => e.name)).toEqual(["root"]);
  });

  test("deliver hands the provider the key it observed", async () => {
    const { store, host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    const agent = store.agentByName("one");
    if (!agent) throw new Error("agent missing");
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
    const a = t.identify({ host: "elsewhere", key: "x", name: "lonely" });
    expect(t.list().map((e) => `${e.name}:${e.note}`)).toEqual(["lonely:by sync"]);
    const result = await t.deliver(a, outbound(a, "hi"), () => undefined);
    expect(result.status).toBe("sent");
  });

  test("identify binds to the observed agent, not a new one", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    const a = t.identify({ host: "fake", key: "k1", name: "one" });
    expect(t.list()[0]?.id).toBe(a.id);
    expect(t.list()).toHaveLength(1);
  });

  test("the manager owns watches: drops finished ones, closes the rest on stop", async () => {
    const { store, host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
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

  test("a failing provider keeps its last presence", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    host.discovery.observe = async () => {
      throw new Error("host down");
    };
    await t.reconcile();
    expect(t.list().map((e) => e.name)).toEqual(["one"]);
  });
});
