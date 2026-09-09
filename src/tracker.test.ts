import { describe, expect, test } from "bun:test";
import type { HostAdapter, Observation } from "./core/adapter.ts";
import { Store } from "./core/store.ts";
import { Tracker } from "./tracker.ts";

/** A fake host whose identity is an opaque token the tracker must never read. */
class FakeHost implements HostAdapter {
  readonly host = "fake";
  live: Observation[] = [];
  delivered: Array<{ handle: unknown; text: string }> = [];
  constructor(private readonly secret = "sealed") {}
  async observe() {
    return this.live;
  }
  handleFromKey(key: string) {
    return { [this.secret]: key };
  }
  async deliver(handle: unknown, text: string, _marker: string, onReceipt: () => void) {
    this.delivered.push({ handle, text });
    onReceipt();
    return { outcome: "delivered" as const };
  }
}

function obs(key: string, name: string, extra: Partial<Observation> = {}): Observation {
  return {
    handle: { opaque: key, nested: { thing: true } },
    key,
    name,
    durability: "session",
    relationship: "top-level",
    evidence: "fake",
    reachable: true,
    ...extra,
  };
}

describe("tracker", () => {
  test("observations become agents; the same key stays the same agent across passes", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const t = new Tracker(store, [host]);
    host.live = [obs("k1", "one"), obs("k2", "two")];
    await t.reconcile();
    const first = t.list();
    expect(first.map((e) => e.name).sort()).toEqual(["one", "two"]);
    const idOne = first.find((e) => e.name === "one")?.id;

    host.live = [obs("k1", "one renamed by host")];
    await t.reconcile();
    const second = t.list();
    expect(second.map((e) => e.name)).toEqual(["one renamed by host"]); // follows the host until pinned
    expect(second[0]?.id).toBe(idOne); // but the id is ours and never changes
    expect(t.list(undefined, ["gone"]).map((e) => e.name)).toEqual(["two"]);

    host.live = [obs("k1", "one"), obs("k2", "two")];
    await t.reconcile();
    expect(t.list().find((e) => e.name === "two")?.id).toBe(
      first.find((e) => e.name === "two")?.id,
    );
  });

  test("a user-pinned name is not overridden by the host", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const t = new Tracker(store, [host]);
    host.live = [obs("k1", "one")];
    await t.reconcile();
    const id = t.list()[0]?.id ?? "";
    expect(store.rename(id, "my-agent")).toBe("my-agent");
    host.live = [obs("k1", "host changed it")];
    await t.reconcile();
    expect(t.list()[0]?.name).toBe("my-agent");
  });

  test("subagents never become peers", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const t = new Tracker(store, [host]);
    host.live = [
      obs("root", "root"),
      obs("child", "child", { relationship: "subagent", parentKey: "root" }),
    ];
    await t.reconcile();
    expect(t.list().map((e) => e.name)).toEqual(["root"]);
  });

  test("deliver hands the adapter its own sealed handle, unmodified", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const t = new Tracker(store, [host]);
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
    expect(host.delivered[0]?.handle).toEqual({ opaque: "k1", nested: { thing: true } });
  });

  test("identify attests an observed agent and rebuilds the handle via the adapter", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost("secretField");
    const t = new Tracker(store, [host]);
    host.live = [obs("k1", "one")];
    await t.reconcile();
    expect(store.handleOf(t.list()[0]?.id ?? "")?.attestation).toBe("observed");
    const a = t.identify({ host: "fake", key: "k1", name: "one", evidence: "hook" });
    expect(a.name).toBe("one");
    const h = store.handleOf(a.id);
    expect(h?.attestation).toBe("attested");
    expect(JSON.parse(h?.handle ?? "{}")).toEqual({ secretField: "k1" });
  });

  test("a failing adapter does not mark its agents gone", async () => {
    const store = new Store(":memory:");
    const host = new FakeHost();
    const t = new Tracker(store, [host]);
    host.live = [obs("k1", "one")];
    await t.reconcile();
    host.observe = async () => {
      throw new Error("host down");
    };
    await t.reconcile();
    expect(t.list().map((e) => e.name)).toEqual(["one"]);
  });
});
