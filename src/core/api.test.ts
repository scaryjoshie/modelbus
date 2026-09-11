import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, rpc } from "../client.ts";
import { createDaemon } from "../daemon.ts";
import { parseToken } from "../identity.ts";
import { Api, ApiError } from "./api.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { Store } from "./store.ts";

const bindTest = (store: Store, key: string, name: string) =>
  store.bind({ provider: "test", key, name });

function fresh() {
  const store = new Store(":memory:");
  const api = new Api(store);
  const a = bindTest(store, "a", "alice");
  const b = bindTest(store, "b", "bob");
  const ab = store.dm(a.id, b.id).id;
  return { store, api, a, b, ab };
}

describe("dm basics", () => {
  test("send then pull delivers once", async () => {
    const { api, a, b, ab } = fresh();
    await api.send({ fromId: a.id, conversationId: ab, body: "hi bob" });
    const first = await api.pull({ agentId: b.id });
    expect(first.items.map((i) => `${i.fromName}: ${i.body}`)).toEqual(["alice: hi bob"]);
    const second = await api.pull({ agentId: b.id });
    expect(second.items).toHaveLength(0);
  });

  test("sender does not receive own message", async () => {
    const { api, a, ab } = fresh();
    await api.send({ fromId: a.id, conversationId: ab, body: "x" });
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

  test("an unknown conversation and a non-member sender are errors", async () => {
    const { store, api, a, ab } = fresh();
    await expect(
      api.send({ fromId: a.id, conversationId: "nowhere", body: "x" }),
    ).rejects.toBeInstanceOf(ApiError);
    const c = bindTest(store, "c", "carol");
    await expect(api.send({ fromId: c.id, conversationId: ab, body: "x" })).rejects.toBeInstanceOf(
      ApiError,
    ); // not a member
  });
});

describe("guards", () => {
  test("identical message within window is dropped", async () => {
    const { api, a, ab } = fresh();
    await api.send({ fromId: a.id, conversationId: ab, body: "same" });
    await expect(api.send({ fromId: a.id, conversationId: ab, body: "same" })).rejects.toThrow(
      /identical/,
    );
  });

  test("rate limit refuses the send after the limit", async () => {
    const { api, a, ab } = fresh();
    for (let i = 0; i < DEFAULT_LIMITS.rateLimit; i++) {
      await api.send({ fromId: a.id, conversationId: ab, body: `m${i}` });
    }
    await expect(
      api.send({ fromId: a.id, conversationId: ab, body: "one too many" }),
    ).rejects.toThrow(/over 10 sends/);
  });

  test("body cap", async () => {
    const { api, a, ab } = fresh();
    await expect(
      api.send({
        fromId: a.id,
        conversationId: ab,
        body: "x".repeat(DEFAULT_LIMITS.bodyCapBytes + 1),
      }),
    ).rejects.toThrow(/exceeds/);
  });

  test("limits are options; unspecified ones keep their defaults", async () => {
    const store = new Store(":memory:");
    const api = new Api(store, { bodyCapBytes: 8, rateLimit: 1 });
    const a = bindTest(store, "a", "alice");
    const b = bindTest(store, "b", "bob");
    const ab = store.dm(a.id, b.id).id;
    expect(api.limits.pullLimit).toBe(DEFAULT_LIMITS.pullLimit);
    await expect(api.send({ fromId: a.id, conversationId: ab, body: "123456789" })).rejects.toThrow(
      /exceeds 8/,
    );
    await api.send({ fromId: a.id, conversationId: ab, body: "ok" });
    await expect(api.send({ fromId: a.id, conversationId: ab, body: "two" })).rejects.toThrow(
      /over 1/,
    );
  });
});

describe("waiting", () => {
  test("pull(wait) resolves when a message arrives", async () => {
    const { api, a, b, ab } = fresh();
    const pending = api.pull({ agentId: b.id, wait: 5 });
    setTimeout(() => api.send({ fromId: a.id, conversationId: ab, body: "late" }), 20);
    const r = await pending;
    expect(r.items[0]?.body).toBe("late");
  });

  test("send(wait) returns the reply and consumes only that DM", async () => {
    const { store, api, a, b, ab } = fresh();
    const c = bindTest(store, "c", "carol");
    await api.send({
      fromId: c.id,
      conversationId: store.dm(c.id, a.id).id,
      body: "unrelated from carol",
    });
    const pending = api.send({ fromId: a.id, conversationId: ab, body: "question?", wait: 5 });
    setTimeout(async () => {
      const inbox = await api.pull({ agentId: b.id });
      expect(inbox.items[0]?.body).toBe("question?");
      await api.send({ fromId: b.id, conversationId: ab, body: "answer!" });
    }, 20);
    const r = await pending;
    expect(r.reply?.body).toBe("answer!");
    // carol's message is still unread for alice
    const rest = await api.pull({ agentId: a.id });
    expect(rest.items.map((i) => i.body)).toEqual(["unrelated from carol"]);
  });

  test("scoped pull leaves other DMs unread", async () => {
    const { store, api, a, b, ab } = fresh();
    const c = bindTest(store, "c", "carol");
    const cb = store.dm(c.id, b.id).id;
    await api.send({ fromId: a.id, conversationId: ab, body: "from alice" });
    await api.send({ fromId: c.id, conversationId: cb, body: "from carol" });
    const scoped = await api.pull({ agentId: b.id, conversationId: cb });
    expect(scoped.items.map((i) => i.body)).toEqual(["from carol"]);
    expect(scoped.more).toBe(0);
    expect(scoped.moreElsewhere).toBe(1);
    const all = await api.pull({ agentId: b.id });
    expect(all.items.map((i) => i.body)).toEqual(["from alice"]);
  });
});

describe("redelivery", () => {
  const withDeliver = (api: Api, status: "sent" | "delivered" | "failed") =>
    api.setDeliver(async () => ({ status, detail: "fake" }));
  const statusOf = (api: Api) => api.log({}).map((r) => r.status);

  test("sent and failed messages go out when asked; delivered ones are left alone", async () => {
    const { api, a, b, ab } = fresh();
    withDeliver(api, "sent");
    await api.send({ fromId: a.id, conversationId: ab, body: "waiting" });
    withDeliver(api, "failed");
    await api.send({ fromId: a.id, conversationId: ab, body: "rejected" });
    withDeliver(api, "delivered");
    await api.send({ fromId: a.id, conversationId: ab, body: "already there" });
    expect(statusOf(api)).toEqual(["sent", "failed", "delivered"]);

    let pushed: string[] = [];
    api.setDeliver(async (_to, o) => {
      pushed.push(o.message.body);
      return { status: "delivered" };
    });
    expect(await api.redeliver(b.id)).toEqual({ delivered: 2, failed: 0, waiting: 0 });
    expect(pushed).toEqual(["waiting", "rejected"]); // oldest first; the delivered one untouched
    expect(statusOf(api)).toEqual(["delivered", "delivered", "delivered"]);

    pushed = [];
    expect(await api.redeliver(b.id)).toEqual({ delivered: 0, failed: 0, waiting: 0 });
    expect(pushed).toEqual([]);
  });

  test("includeDelivered also pushes delivered-but-unread, for hosts that drop their queue", async () => {
    const { api, a, b, ab } = fresh();
    withDeliver(api, "delivered");
    await api.send({ fromId: a.id, conversationId: ab, body: "lost by the host" });
    const pushed: string[] = [];
    api.setDeliver(async (_to, o) => {
      pushed.push(o.message.body);
      return { status: "delivered" };
    });
    expect(await api.redeliver(b.id)).toEqual({ delivered: 0, failed: 0, waiting: 0 });
    expect(await api.redeliver(b.id, { includeDelivered: true })).toEqual({
      delivered: 1,
      failed: 0,
      waiting: 0,
    });
    expect(pushed).toEqual(["lost by the host"]);
  });

  test("a retry that fails again stays failed; a pull-only recipient stays waiting", async () => {
    const { api, a, b, ab } = fresh();
    withDeliver(api, "failed");
    await api.send({ fromId: a.id, conversationId: ab, body: "x" });
    expect(await api.redeliver(b.id)).toEqual({ delivered: 0, failed: 1, waiting: 0 });
    withDeliver(api, "sent");
    expect(await api.redeliver(b.id)).toEqual({ delivered: 0, failed: 0, waiting: 1 });
    expect(statusOf(api)).toEqual(["sent"]);
    expect((await api.pull({ agentId: b.id })).items.map((i) => i.body)).toEqual(["x"]);
  });

  test("a push in flight is not pushed a second time", async () => {
    const { api, a, b, ab } = fresh();
    let release: () => void = () => undefined;
    let pushes = 0;
    api.setDeliver(async () => {
      pushes++;
      await new Promise<void>((r) => {
        release = r;
      });
      return { status: "delivered" };
    });
    const sending = api.send({ fromId: a.id, conversationId: ab, body: "slow" });
    await Promise.resolve(); // let send reach the push
    expect(await api.redeliver(b.id)).toEqual({ delivered: 0, failed: 0, waiting: 0 });
    release();
    await sending;
    expect(pushes).toBe(1);
  });
});

describe("groups and names", () => {
  test("a group message reaches every member but the sender; non-members cannot send", async () => {
    const { store, api, a, b, ab } = fresh();
    const c = bindTest(store, "c", "carol");
    const d = bindTest(store, "d", "dave");
    const g = api.group({ name: "backend", add: [a.id, b.id, c.id] });
    expect(g.conversation.kind).toBe("group");
    expect(g.members.sort()).toEqual([a.id, b.id, c.id].sort());
    const r = await api.send({
      fromId: a.id,
      conversationId: g.conversation.id,
      body: "hello all",
    });
    expect(r.deliveries.map((x) => x.to.name).sort()).toEqual(["bob", "carol"]);
    expect((await api.pull({ agentId: b.id })).items.map((i) => i.body)).toEqual(["hello all"]);
    expect((await api.pull({ agentId: c.id })).items.map((i) => i.body)).toEqual(["hello all"]);
    expect((await api.pull({ agentId: a.id })).items).toEqual([]);
    await expect(
      api.send({ fromId: d.id, conversationId: g.conversation.id, body: "outsider" }),
    ).rejects.toThrow(/not in this conversation/);
    // removing a member stops their copies; the DM between a and b is untouched
    api.group({ name: "backend", remove: [c.id] });
    const r2 = await api.send({ fromId: a.id, conversationId: g.conversation.id, body: "again" });
    expect(r2.deliveries.map((x) => x.to.name)).toEqual(["bob"]);
    expect(store.participants(ab).sort()).toEqual([a.id, b.id].sort());
  });

  test("waiting in a group returns the next message from anyone else", async () => {
    const { store, api, a, b } = fresh();
    const c = bindTest(store, "c", "carol");
    const g = api.group({ name: "trio", add: [a.id, b.id, c.id] }).conversation.id;
    const pending = api.send({ fromId: a.id, conversationId: g, body: "anyone?", wait: 5 });
    setTimeout(() => api.send({ fromId: c.id, conversationId: g, body: "carol here" }), 20);
    const r = await pending;
    expect(r.reply?.fromName).toBe("carol");
    // bob still has both messages unread; alice consumed carol's inline
    expect((await api.pull({ agentId: b.id })).items.map((i) => i.body)).toEqual([
      "anyone?",
      "carol here",
    ]);
    expect((await api.pull({ agentId: a.id })).items).toEqual([]);
  });

  test("rename pins the name, keeps the old one as an alias, and refuses a taken name", () => {
    const { store, api, a, b } = fresh();
    const renamed = api.rename(a.id, "reviewer");
    expect(renamed.name).toBe("reviewer");
    expect(renamed.formerName).toBe("alice");
    expect(store.agentByName("alice")?.id).toBe(a.id); // alias still resolves
    expect(store.agentByName("reviewer")?.id).toBe(a.id);
    // the host renaming the session no longer applies
    expect(bindTest(store, "a", "alice renamed by host").name).toBe("reviewer");
    expect(() => api.rename(b.id, "reviewer")).toThrow(/taken/);
    expect(() => api.rename(b.id, "#nope")).toThrow(/start with #/);
  });

  test("describe sets one line of purpose; empty clears it", () => {
    const { store, api, a } = fresh();
    expect(api.describe(a.id, "  reviews auth changes\nsecond line ignored ").purpose).toBe(
      "reviews auth changes",
    );
    expect(store.agentById(a.id)?.purpose).toBe("reviews auth changes");
    expect(api.describe(a.id, "   ").purpose).toBeNull();
    expect(() => api.describe("nope", "x")).toThrow(/unknown agent/);
  });

  test("chats overview and history paging", async () => {
    const { store, api, a, b, ab } = fresh();
    const c = bindTest(store, "c", "carol");
    const g = api.group({ name: "backend", add: [a.id, b.id, c.id] }).conversation.id;
    for (const n of [1, 2, 3]) await api.send({ fromId: a.id, conversationId: g, body: `g${n}` });
    await api.send({ fromId: b.id, conversationId: ab, body: "dm1" });
    const chats = api.conversations();
    expect(chats.map((x) => (x.kind === "group" ? `#${x.name}` : "dm"))).toEqual([
      "dm",
      "#backend",
    ]);
    const group = chats[1];
    expect(group?.participants.map((p) => p.name).sort()).toEqual(["alice", "bob", "carol"]);
    expect(group?.last?.body).toBe("g3");
    expect(group?.unread).toBe(6); // three messages, two recipients each, none read
    await api.pull({ agentId: b.id, conversationId: g });
    expect(api.conversations()[1]?.unread).toBe(3);

    const page = api.history({ conversationId: g, limit: 2 });
    expect(page.map((m) => m.body)).toEqual(["g2", "g3"]);
    const earlier = api.history({ conversationId: g, beforeSeq: page[0]?.seq, limit: 2 });
    expect(earlier.map((m) => m.body)).toEqual(["g1"]);
    expect(() => api.history({ conversationId: "nope" })).toThrow(/unknown conversation/);
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
      expect(statSync(unix).mode & 0o777).toBe(0o600); // the door is owner-only
      expect(statSync(join(dir, "d.db")).mode & 0o777).toBe(0o600); // so is the database
      const app = await rpc("register", { name: "app" }, undefined, unix);
      const other = await rpc("register", { name: "other" }, undefined, unix);
      expect(app.agent.name).toBe("app");
      expect(app.token.length).toBeGreaterThan(8);
      const who = await rpc("who", {}, undefined, unix);
      expect(who.agents.map((a) => `${a.name}:${a.provider}`).sort()).toEqual([
        "app:unspecified",
        "other:unspecified",
      ]);

      const appClient = createClient(parseToken(app.token), unix);
      const otherClient = createClient(parseToken(other.token), unix);
      const sent = await otherClient.request("send", { to: "app", body: "hi app" });
      expect(sent.deliveries[0]?.status).toBe("sent");
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
    const alice = { kind: "self", provider: "cli", key: "a", name: "alice" } as const;
    const bob = { kind: "self", provider: "cli", key: "b", name: "bob" } as const;
    await rpc("bind", {}, bob, unix);
    const sent = await rpc("send", { to: "bob", body: "over the wire" }, alice, unix);
    expect(sent.deliveries[0]?.to.name).toBe("bob");
    expect(sent.deliveries[0]?.status).toBe("sent");
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

describe("protocol: groups over the wire", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "modelbus-groups-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("#group addressing, who scoped to groupmates, and a renamed agent's old name", async () => {
    const unix = join(dir, "d.sock");
    const d = createDaemon({
      store: new Store(join(dir, "d.db")),
      unix,
      providers: [],
      track: false,
    });
    try {
      const id = (name: string) => ({ kind: "self", provider: "cli", key: name, name }) as const;
      for (const n of ["alice", "bob", "carol", "dave"]) await rpc("bind", {}, id(n), unix);
      const g = await rpc(
        "group",
        { name: "#backend", add: ["alice", "bob", "carol"] },
        undefined,
        unix,
      );
      expect(g.members.map((m) => m.name).sort()).toEqual(["alice", "bob", "carol"]);

      const sent = await rpc("send", { to: "#backend", body: "hi team" }, id("alice"), unix);
      expect(sent.deliveries.map((x) => x.to.name).sort()).toEqual(["bob", "carol"]);
      await expect(rpc("send", { to: "#backend", body: "x" }, id("dave"), unix)).rejects.toThrow(
        /not in this conversation/,
      );
      await expect(rpc("send", { to: "#nope", body: "x" }, id("alice"), unix)).rejects.toThrow(
        /no group named/,
      );

      // a member sees groupmates by default, everyone with all; an outsider sees everyone
      const names = (r: { agents: Array<{ name: string }> }) => r.agents.map((a) => a.name).sort();
      expect(names(await rpc("who", {}, id("alice"), unix))).toEqual(["alice", "bob", "carol"]);
      expect(names(await rpc("who", { all: true }, id("alice"), unix))).toHaveLength(4);
      expect(names(await rpc("who", {}, id("dave"), unix))).toHaveLength(4);
      expect(names(await rpc("who", { group: "#backend" }, undefined, unix))).toEqual([
        "alice",
        "bob",
        "carol",
      ]);

      const chats = await rpc("conversations", {}, undefined, unix);
      expect(chats.conversations[0]?.name).toBe("backend");
      const hist = await rpc("history", { conversation: "#backend" }, undefined, unix);
      expect(hist.items.map((m) => m.body)).toEqual(["hi team"]);

      await rpc("rename", { agent: "bob", name: "reviewer" }, undefined, unix);
      const late = await rpc("send", { to: "bob", body: "old name" }, id("alice"), unix);
      expect(late.deliveries[0]?.to.name).toBe("reviewer"); // the alias landed it
      // the session's key is unchanged; the host's own name claim no longer applies
      const scoped = await rpc("pull", { scope: "#backend" }, id("bob"), unix);
      expect((await rpc("bind", {}, id("bob"), unix)).agent.name).toBe("reviewer");
      expect(scoped.items.map((m) => m.body)).toEqual(["hi team"]);
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

  test("unread messages survive a store restart", async () => {
    const path = join(dir, "t.db");
    let store = new Store(path);
    let api = new Api(store);
    const a = bindTest(store, "a", "alice");
    const b = bindTest(store, "b", "bob");
    const ab = store.dm(a.id, b.id).id;
    await api.send({ fromId: a.id, conversationId: ab, body: "before restart" });
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
