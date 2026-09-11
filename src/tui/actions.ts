import { rpc } from "../client.ts";
import type { Effect, Msg } from "./state.ts";

/**
 * The daemon calls behind Enter and the prompts. `update` names what it wants
 * as an `Effect`; this turns it into RPCs and a message back. Never throws: a
 * failure is a message too, so the status row can show it.
 */

/** How many messages one page of a chat asks for; the daemon caps it at its pull limit. */
export const HISTORY_PAGE_LIMIT = 50;

export async function runEffect(effect: Effect, request = rpc): Promise<Msg | undefined> {
  try {
    return await run(effect, request);
  } catch (e) {
    return { type: "actionFailed", error: e instanceof Error ? e.message : String(e) };
  }
}

async function run(effect: Effect, request: typeof rpc): Promise<Msg | undefined> {
  switch (effect.type) {
    case "loadHistory": {
      const page = await request("history", {
        conversation: effect.spec,
        limit: HISTORY_PAGE_LIMIT,
      });
      return { type: "history", id: effect.id, messages: page.items, at: Date.now() };
    }
    case "openDm": {
      // Resolving "a,b" is what creates the DM; an empty one carries no id in
      // its messages, so the list is asked for it afterwards.
      const spec = `${effect.a},${effect.b}`;
      const page = await request("history", { conversation: spec, limit: HISTORY_PAGE_LIMIT });
      const { conversations } = await request("conversations", {});
      const pair = new Set([effect.a, effect.b]);
      const dm = conversations.find(
        (c) =>
          c.kind === "dm" &&
          c.participants.length === pair.size &&
          c.participants.every((p) => pair.has(p.name)),
      );
      if (!dm) throw new Error(`no DM between ${effect.a} and ${effect.b} after opening it`);
      return { type: "conversationCreated", id: dm.id, conversations, messages: page.items };
    }
    case "createGroup": {
      const { conversation } = await request("group", {
        name: effect.name,
        add: effect.members,
      });
      const spec = `#${conversation.name ?? effect.name}`;
      const page = await request("history", { conversation: spec, limit: HISTORY_PAGE_LIMIT });
      const { conversations } = await request("conversations", {});
      return {
        type: "conversationCreated",
        id: conversation.id,
        conversations,
        messages: page.items,
      };
    }
    case "rename":
      await request("rename", { agent: effect.agent, name: effect.name });
      return undefined;
  }
}
