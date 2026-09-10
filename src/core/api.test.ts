import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, rpc } from "../client.ts";
import { createDaemon } from "../daemon.ts";
import { parseToken } from "../identity.ts";
import { Api, ApiError } from "./api.ts";
import { GUARDS } from "./guards.ts";
import { Store } from "./store.ts";

const bindTest = (store: Store, key: string, name: string) =>
  store.bind({ host: "test", key, name });

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
    await api.send({ fromId: a.id, toId: b.id, body: "hi bob" });
    const first = await api.pull({ agentId: b.id });
    expect(first.items.map((i) => `${i.fromName}: ${i.body}`)).toEqual(["alice: hi bob"]);
    const second = await api.pull({ agentId: b.id });
    expect(second.items).toHaveLength(0);
  });

  test("sender does not receive own message", async () => {
    const { api, a, b } = fresh();
    await api.send({ fromId: a.id, toId: b.id, body: "x" });
    expect((await api.pull({ agentId: a.id })).items).toHaveLength(0);
  });

  test("binding is identity; names de-duplicate and follow the host", () => {
    const { store, a } = fresh();
    const again = bindTest(store, "a", "alice");
    expect(again.id).toBe(a.id);
    const clash = bindTest(store, "c", "alice");
    expect(clash.name).toBe("alice-2"); // same host name, different session: de-duplicated
    expect(bindTest(store, "a", "alice renamed").name).toBe("alice renamed");
    expect(bindTest(store, "c", "alice renamed").name).toBe("alice-2"); // taken: keeps its own
  });

  test("unknown recipient and self-send are errors", async () => {
    const { api, a } = fresh();
    await expect(api.send({ fromId: a.id, toId: "nobody", body: "x" })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api.send({ fromId: a.id, toId: a.id, body: "x" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("guards", () => {
  test("identical message within window is dropped", async () => {
    const { api, a, b } = fresh();
    await api.send({ fromId: a.id, toId: b.id, body: "same" });
    await expect(api.send({ fromId: a.id, toId: b.id, body: "same" })).rejects.toThrow(/identical/);
  });

  test("rate limit refuses the send after the limit", async () => {
    const { api, a, b } = fresh();
    for (let i = 0; i < GUARDS.RATE_LIMIT; i++) {
      await api.send({ fromId: a.id, toId: b.id, body: `m${i}` });
    }
    await expect(api.send({ fromId: a.id, toId: b.id, body: "one too many" })).rejects.toThrow(
      /per minute/,
    );
  });

  test("body cap", async () => {
    const { api, a, b } = fresh();
    await expect(
      api.send({ fromId: a.id, toId: b.id, body: "x".repeat(GUARDS.BODY_CAP_BYTES + 1) }),
    ).rejects.toThrow(/exceeds/);
  });
});

describe("waiting", () => {
  test("pull(wait) resolves when a message arrives", async () => {
    const { api, a, b } = fresh();
    const pending = api.pull({ agentId: b.id, wait: 5 });
    setTimeout(() => api.send({ fromId: a.id, toId: b.id, body: "late" }), 20);
    const r = await pending;
    expect(r.items[0]?.body).toBe("late");
  });

  test("send(wait) returns the reply and consumes only that DM", async () => {
    const { store, api, a, b } = fresh();
    const c = bindTest(store, "c", "carol");
    await api.send({ fromId: c.id, toId: a.id, body: "unrelated from carol" });
    const pending = api.send({ fromId: a.id, toId: b.id, body: "question?", wait: 5 });
    setTimeout(async () => {
      const inbox = await api.pull({ agentId: b.id });
      expect(inbox.items[0]?.body).toBe("question?");
      await api.send({ fromId: b.id, toId: a.id, body: "answer!" });
    }, 20);
    const r = await pending;
    expect(r.reply?.body).toBe("answer!");
    // carol's message is still unread for alice
    const rest = await api.pull({ agentId: a.id });
    expect(rest.items.map((i) => i.body)).toEqual(["unrelated from carol"]);
  });

  test("scoped pull leaves other DMs unread", async () => {
    const { store, api, a, b } = fresh();
    const c = bindTest(store, "c", "carol");
    await api.send({ fromId: a.id, toId: b.id, body: "from alice" });
    await api.send({ fromId: c.id, toId: b.id, body: "from carol" });
    const scoped = await api.pull({ agentId: b.id, scopeId: c.id });
    expect(scoped.items.map((i) => i.body)).toEqual(["from carol"]);
    expect(scoped.more).toBe(0);
    expect(scoped.moreElsewhere).toBe(1);
    const all = await api.pull({ agentId: b.id });
    expect(all.items.map((i) => i.body)).toEqual(["from alice"]);
  });
});

describe("protocol", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "modelbus-proto-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("register: token identity, live while calling in, receives by pull", async () => {
    const unix = join(dir, "d.sock");
    const d = createDaemon({ store: new Store(join(dir, "d.db")), unix, track: false });
    try {
      const app = await rpc("register", { name: "app" }, undefined, unix);
      const other = await rpc("register", { name: "other" }, undefined, unix);
      expect(app.agent.name).toBe("app");
      expect(app.token.length).toBeGreaterThan(8);
      const who = await rpc("who", {}, undefined, unix);
      expect(who.agents.map((a) => `${a.name}:${a.host}`).sort()).toEqual([
        "app:registered",
        "other:registered",
      ]);

      const appClient = createClient(parseToken(app.token), unix);
      const otherClient = createClient(parseToken(other.token), unix);
      const sent = await otherClient.request("send", { to: "app", body: "hi app" });
      expect(sent.delivery.status).toBe("sent");
      expect(sent.message.fromAgentId).toBe(other.agent.id);
      expect((await otherClient.request("pull", {})).items).toEqual([]);
      const pulled = await appClient.request("pull", {});
      expect(pulled.items.map((i) => `${i.fromName}: ${i.body}`)).toEqual(["other: hi app"]);
      expect(pulled.items[0]?.body).not.toContain("[modelbus"); // pull returns the bare body

      await expect(
        rpc("send", { to: "app", body: "x" }, parseToken("nope-nope-nope"), unix),
      ).rejects.toThrow(/unknown token/);
      await expect(
        createClient(
          {
            kind: "token",
            id: app.agent.id,
            secret: "wrong-secret",
          },
          unix,
        ).request("pull", {}),
      ).rejects.toThrow(/bad token/);
    } finally {
      d.stop();
    }
  });

  test("self identity over the socket: send, pull, who, log; survives restart", async () => {
    const unix = join(dir, "d.sock");
    const path = join(dir, "d.db");
    let d = createDaemon({ store: new Store(path), unix, providers: [], track: false });
    const alice = { kind: "self", host: "cli", key: "a", name: "alice" } as const;
    const bob = { kind: "self", host: "cli", key: "b", name: "bob" } as const;
    await rpc("bind", {}, bob, unix);
    const sent = await rpc("send", { to: "bob", body: "over the wire" }, alice, unix);
    expect(sent.to.name).toBe("bob");
    expect(sent.delivery.status).toBe("sent");
    const who = await rpc("who", {}, undefined, unix);
    expect(who.agents.map((x) => x.name).sort()).toEqual(["alice", "bob"]);
    d.stop();

    d = createDaemon({ store: new Store(path), unix, providers: [], track: false });
    expect((await rpc("who", {}, undefined, unix)).agents).toHaveLength(0); // nobody has called in yet
    const pulled = await rpc("pull", {}, bob, unix);
    expect(pulled.items.map((i) => i.body)).toEqual(["over the wire"]);
    const log = await rpc("log", {}, undefined, unix);
    expect(log.rows[0]?.status).toBe("read");
    expect(log.rows[0]?.readAt).not.toBeNull();
    d.stop();
  });
});

describe("persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "modelbus-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("unread messages survive a store restart", async () => {
    const path = join(dir, "t.db");
    let store = new Store(path);
    let api = new Api(store);
    const a = bindTest(store, "a", "alice");
    const b = bindTest(store, "b", "bob");
    await api.send({ fromId: a.id, toId: b.id, body: "before restart" });
    store.close();

    store = new Store(path);
    api = new Api(store);
    const b2 = bindTest(store, "b", "bob");
    const r = await api.pull({ agentId: b2.id });
    expect(r.items.map((i) => i.body)).toEqual(["before restart"]);
    expect((await api.pull({ agentId: b2.id })).items).toHaveLength(0);
    store.close();
  });
});
