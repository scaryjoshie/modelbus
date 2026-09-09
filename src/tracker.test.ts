import { describe, expect, test } from "bun:test";
import type { HostAdapter, Observation } from "./core/adapter.ts";
import { Store } from "./core/store.ts";
import { Tracker } from "./tracker.ts";

class FakeHost implements HostAdapter {
  readonly host = "fake";
  live: Observation[] = [];
  delivered: Array<{ key: string; text: string }> = [];
  async observe() {
    return this.live;
  }
  async deliver(key: string, text: string, _marker: string, onReceipt: () => void) {
    this.delivered.push({ key, text });
    onReceipt();
    return { outcome: "delivered" as const };
  }
}

function obs(key: string, name: string, extra: Partial<Observation> = {}): Observation {
  return { key, name, relationship: "top-level", reachable: true, ...extra };
}

function setup() {
  const store = new Store(":memory:");
  const host = new FakeHost();
  return { store, host, t: new Tracker(store, [host]) };
}

describe("tracker", () => {
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

  test("deliver hands the adapter the key it observed", async () => {
    const { store, host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    const agent = store.agentByName("one");
    if (!agent) throw new Error("agent missing");
    let receipt = false;
    const result = await t.deliver(agent, "hello", "#m1", () => {
      receipt = true;
    });
    expect(result.outcome).toBe("delivered");
    expect(receipt).toBe(true);
    expect(host.delivered).toEqual([{ key: "k1", text: "hello" }]);
  });

  test("an agent nobody observes is live while it calls in", async () => {
    const { t } = setup();
    const a = t.identify({ host: "elsewhere", key: "x", name: "lonely" });
    expect(t.list().map((e) => `${e.name}:${e.note}`)).toEqual(["lonely:by sync"]);
    const result = await t.deliver(a, "hi", "#m", () => undefined);
    expect(result.outcome).toBe("waiting");
  });

  test("identify binds to the observed agent, not a new one", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    const a = t.identify({ host: "fake", key: "k1", name: "one" });
    expect(t.list()[0]?.id).toBe(a.id);
    expect(t.list()).toHaveLength(1);
  });

  test("a failing adapter keeps its last presence", async () => {
    const { host, t } = setup();
    host.live = [obs("k1", "one")];
    await t.reconcile();
    host.observe = async () => {
      throw new Error("host down");
    };
    await t.reconcile();
    expect(t.list().map((e) => e.name)).toEqual(["one"]);
  });
});
