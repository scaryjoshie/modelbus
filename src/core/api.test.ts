import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "../client.ts";
import { createDaemon } from "../daemon.ts";
import { Api, ApiError } from "./api.ts";
import { GUARDS } from "./guards.ts";
import { Store } from "./store.ts";

function bindTest(store: Store, key: string, name: string) {
  return store.bind({
    host: "test",
    key,
    handle: { key },
    durability: "session",
    preferredName: name,
    evidence: "test",
  });
}

function fresh() {
  const store = new Store(":memory:");
  const api = new Api(store);
  const a = bindTest(store, "a", "alice");
  const b = bindTest(store, "b", "bob");
  return { store, api, a, b };
}

describe("dm basics", () => {
  test("send then pull delivers once", async () => {
    const { api, a, b } = fresh();
    await api.send({ fromId: a.id, to: "bob", body: "hi bob" });
    const first = await api.pull({ agentId: b.id });
    expect(first.items.map((i) => `${i.fromName}: ${i.body}`)).toEqual(["alice: hi bob"]);
    const second = await api.pull({ agentId: b.id });
    expect(second.items).toHaveLength(0);
  });

  test("sender does not receive own message", async () => {
    const { api, a } = fresh();
    await api.send({ fromId: a.id, to: "bob", body: "x" });
    expect((await api.pull({ agentId: a.id })).items).toHaveLength(0);
  });

  test("binding is identity; names de-duplicate", () => {
    const { store, a } = fresh();
    const again = bindTest(store, "a", "alice");
    expect(again.id).toBe(a.id);
    const clash = bindTest(store, "c", "alice");
    expect(clash.name).toBe("alice-2"); // same host name, different session: de-duplicated
  });

  test("unknown recipient and self-send are errors", async () => {
    const { api, a } = fresh();
    await expect(api.send({ fromId: a.id, to: "nobody", body: "x" })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api.send({ fromId: a.id, to: "alice", body: "x" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("guards", () => {
  test("identical message within window is dropped", async () => {
    const { api, a } = fresh();
    await api.send({ fromId: a.id, to: "bob", body: "same" });
    await expect(api.send({ fromId: a.id, to: "bob", body: "same" })).rejects.toThrow(/identical/);
  });

  test("rate limit refuses the 11th send in a minute", async () => {
    const { api, a } = fresh();
    for (let i = 0; i < GUARDS.RATE_LIMIT_PER_MINUTE; i++) {
      await api.send({ fromId: a.id, to: "bob", body: `m${i}` });
    }
    await expect(api.send({ fromId: a.id, to: "bob", body: "one too many" })).rejects.toThrow(
      /per minute/,
    );
  });

  test("body cap", async () => {
    const { api, a } = fresh();
    await expect(
      api.send({ fromId: a.id, to: "bob", body: "x".repeat(GUARDS.BODY_CAP_BYTES + 1) }),
    ).rejects.toThrow(/exceeds/);
  });
});

describe("waiting", () => {
  test("pull(wait) resolves when a message arrives", async () => {
    const { api, a, b } = fresh();
    const pending = api.pull({ agentId: b.id, wait: 5 });
    setTimeout(() => api.send({ fromId: a.id, to: "bob", body: "late" }), 20);
    const r = await pending;
    expect(r.items[0]?.body).toBe("late");
  });

  test("send(wait) returns the reply and consumes only that DM", async () => {
    const { store, api, a, b } = fresh();
    const c = bindTest(store, "c", "carol");
    await api.send({ fromId: c.id, to: "alice", body: "unrelated from carol" });
    const pending = api.send({ fromId: a.id, to: "bob", body: "question?", wait: 5 });
    setTimeout(async () => {
      const inbox = await api.pull({ agentId: b.id });
      expect(inbox.items[0]?.body).toBe("question?");
      await api.send({ fromId: b.id, to: "alice", body: "answer!" });
    }, 20);
    const r = await pending;
    expect(r.reply?.body).toBe("answer!");
    // carol's message is still unreceived for alice
    const rest = await api.pull({ agentId: a.id });
    expect(rest.items.map((i) => i.body)).toEqual(["unrelated from carol"]);
  });

  test("scoped pull leaves other DMs unreceived", async () => {
    const { store, api, a, b } = fresh();
    const c = bindTest(store, "c", "carol");
    await api.send({ fromId: a.id, to: "bob", body: "from alice" });
    await api.send({ fromId: c.id, to: "bob", body: "from carol" });
    const scoped = await api.pull({ agentId: b.id, scope: "carol" });
    expect(scoped.items.map((i) => i.body)).toEqual(["from carol"]);
    expect(scoped.more).toBe(0);
    expect(scoped.moreElsewhere).toBe(1);
    const all = await api.pull({ agentId: b.id });
    expect(all.items.map((i) => i.body)).toEqual(["from alice"]);
  });
});

describe("protocol: registration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "modelbus-proto-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("register, send with token, receive by pull and by deliver command", async () => {
    const unix = join(dir, "d.sock");
    const out = join(dir, "inbox.txt");
    const d = createDaemon({ store: new Store(join(dir, "d.db")), unix, track: false });
    try {
      const app = await rpc<{ agent: { name: string }; token: string }>(
        "register",
        { name: "app", host: "test app", deliver: `cat >> ${out}` },
        undefined,
        unix,
      );
      const other = await rpc<{ agent: { name: string }; token: string }>(
        "register",
        { name: "other" },
        undefined,
        unix,
      );
      expect(app.agent.name).toBe("app");
      expect(app.token.length).toBeGreaterThan(8);

      // other -> app: delivered by running app's command
      const sent = await rpc<{ delivery: { outcome: string } }>(
        "send",
        { to: "app", body: "hi app" },
        { kind: "token", token: other.token },
        unix,
      );
      expect(sent.delivery.outcome).toBe("delivered");
      expect(await Bun.file(out).text()).toContain("hi app");
      expect(await Bun.file(out).text()).toContain("[modelbus #");

      // app -> other: other has no deliver command, so it pulls
      await rpc(
        "send",
        { to: "other", body: "hi other" },
        { kind: "token", token: app.token },
        unix,
      );
      const pulled = await rpc<{ items: Array<{ body: string; fromName: string }> }>(
        "pull",
        {},
        { kind: "token", token: other.token },
        unix,
      );
      expect(pulled.items.map((i) => `${i.fromName}: ${i.body}`)).toEqual(["app: hi other"]);

      // an unknown token is refused
      await expect(
        rpc("send", { to: "app", body: "x" }, { kind: "token", token: "nope-nope-nope" }, unix),
      ).rejects.toThrow(/unknown token/);
    } finally {
      d.stop();
    }
  });
});

describe("persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "modelbus-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("unreceived messages survive a store restart", async () => {
    const path = join(dir, "t.db");
    let store = new Store(path);
    let api = new Api(store);
    const a = bindTest(store, "a", "alice");
    bindTest(store, "b", "bob");
    await api.send({ fromId: a.id, to: "bob", body: "before restart" });
    store.close();

    store = new Store(path);
    api = new Api(store);
    const b2 = bindTest(store, "b", "bob");
    const r = await api.pull({ agentId: b2.id });
    expect(r.items.map((i) => i.body)).toEqual(["before restart"]);
    expect((await api.pull({ agentId: b2.id })).items).toHaveLength(0);
    store.close();
  });

  test("daemon over unix socket: send, pull, who, log; survives restart", async () => {
    const unix = join(dir, "d.sock");
    const path = join(dir, "d.db");
    let d = createDaemon({ store: new Store(path), unix, adapters: [], track: false });
    const alice = { kind: "cli", as: "alice" } as const;
    const bob = { kind: "cli", as: "bob" } as const;
    await rpc("bind", {}, bob, unix);
    const sent = await rpc<{ to: { name: string }; delivery: { outcome: string } }>(
      "send",
      { to: "bob", body: "over the wire" },
      alice,
      unix,
    );
    expect(sent.to.name).toBe("bob");
    expect(sent.delivery.outcome).toBe("waiting");
    const who = await rpc<{ agents: Array<{ name: string }> }>("who", {}, undefined, unix);
    expect(who.agents.map((x) => x.name).sort()).toEqual(["alice", "bob"]);
    d.stop();

    d = createDaemon({ store: new Store(path), unix, adapters: [], track: false });
    const pulled = await rpc<{ items: Array<{ body: string }> }>("pull", {}, bob, unix);
    expect(pulled.items.map((i) => i.body)).toEqual(["over the wire"]);
    const log = await rpc<{ rows: Array<{ receivedAt: number | null }> }>(
      "log",
      {},
      undefined,
      unix,
    );
    expect(log.rows[0]?.receivedAt).not.toBeNull();
    d.stop();
  });
});
