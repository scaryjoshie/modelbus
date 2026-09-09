import { socketPath } from "./core/paths.ts";

/** Minimal RPC client over the daemon's unix socket. */

export type Identity =
  | { kind: "cli"; as: string }
  | { kind: "self"; host: string; key: string; name: string; evidence?: string }
  | { kind: "token"; token: string };

export class DaemonUnreachable extends Error {}

export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  identity?: Identity,
  unix: string = socketPath(),
): Promise<T> {
  let res: Response;
  try {
    res = await fetch("http://modelbus/rpc", {
      unix,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params, identity }),
    });
  } catch (e) {
    throw new DaemonUnreachable(
      `cannot reach modelbus daemon at ${unix} (${e instanceof Error ? e.message : e}); start it with: modelbus serve`,
    );
  }
  const data = (await res.json()) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error ?? `rpc ${method} failed (${res.status})`);
  return data;
}
