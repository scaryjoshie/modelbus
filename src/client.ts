import type { z } from "zod";
import { socketPath } from "./core/paths.ts";
import type { Identity, Methods } from "./daemon.ts";

/**
 * RPC client over the daemon's unix socket. Method names, params, and results are
 * checked against the daemon's method table, so a typo or a wrong field fails to
 * compile rather than at runtime.
 */

export type { Identity };
export type MethodName = keyof Methods;
export type Params<M extends MethodName> = z.input<Methods[M]["params"]>;
export type Result<M extends MethodName> = Awaited<ReturnType<Methods[M]["handler"]>>;

export class DaemonUnreachable extends Error {}

/** Bind a caller once. Credentials travel in the envelope, never in tool arguments. */
export function createClient(identity: Identity, unix: string = socketPath()) {
  return {
    request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
      return rpc(method, params, identity, unix);
    },
  };
}

export async function rpc<M extends MethodName>(
  method: M,
  params: Params<M>,
  identity?: Identity,
  unix: string = socketPath(),
): Promise<Result<M>> {
  let res: Response;
  try {
    res = await fetch("http://modelbus/rpc", {
      unix,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params, identity }),
    });
  } catch (e) {
    throw new DaemonUnreachable(`modelbus is not running (${unix}); start it with: modelbus start`);
  }
  const data = (await res.json()) as { error?: string } & Result<M>;
  if (!res.ok) throw new Error(data.error ?? `rpc ${method} failed (${res.status})`);
  return data;
}
