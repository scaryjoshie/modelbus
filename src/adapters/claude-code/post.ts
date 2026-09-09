import { createConnection } from "node:net";

/**
 * Write one user message to a Claude Code inbox socket.
 *
 * Claude Code honours the session token only if the writing process has already
 * exited when it checks, so the daemon never writes directly: it spawns this file
 * as a short-lived helper with { socketPath, token?, text } on stdin.
 */

const SOCKET_TIMEOUT_MS = 5000;

export function post(socketPath: string, token: string | undefined, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: socketPath });
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    sock.on("connect", () => {
      const lines: string[] = [];
      if (token) lines.push(JSON.stringify({ type: "auth", token }));
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
      sock.end(`${lines.join("\n")}\n`, () => resolve());
    });
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("socket timeout"));
    });
    sock.on("error", reject);
  });
}

/** Run this file as a helper that posts and exits at once. */
export async function postViaHelper(socketPath: string, token: string | undefined, text: string) {
  const child = Bun.spawn([process.execPath, import.meta.path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ socketPath, token, text }));
  child.stdin.end();
  const code = await child.exited;
  if (code !== 0) {
    throw new Error((await new Response(child.stderr).text()).trim() || `helper exit ${code}`);
  }
}

if (import.meta.main) {
  const p = JSON.parse(await Bun.stdin.text()) as {
    socketPath: string;
    token?: string;
    text: string;
  };
  await post(p.socketPath, p.token, p.text);
}
