import { $ } from "bun";

export interface ProcInfo {
  pid: number;
  ppid: number;
  tty?: string;
  /** Process start time as epoch ms, best effort. */
  startedAt?: number;
  args: string;
  /** basename of argv[0] */
  exe: string;
}

let cache: { at: number; procs: ProcInfo[] } | undefined;

/** Snapshot of the process table. Cached for one second so providers can share it. */
export async function listProcesses(): Promise<ProcInfo[]> {
  if (cache && Date.now() - cache.at < 1000) return cache.procs;
  // lstart is a fixed-width date; args is last so it may contain spaces.
  const out = await $`ps -axo pid=,ppid=,tty=,lstart=,args=`.text();
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/,
    );
    if (!m) continue;
    const [, pid, ppid, tty, lstart, args] = m;
    if (!pid || !ppid || !args) continue;
    const exe = (args.split(" ")[0] ?? "").split("/").pop() ?? "";
    const started = lstart ? Date.parse(lstart) : Number.NaN;
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      tty: tty && tty !== "??" ? tty : undefined,
      startedAt: Number.isNaN(started) ? undefined : started,
      args,
      exe,
    });
  }
  cache = { at: Date.now(), procs };
  return procs;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Current working directory of a process via lsof. Returns undefined if unavailable. */
export async function cwdOf(pid: number): Promise<string | undefined> {
  try {
    const out = await $`lsof -a -p ${pid} -d cwd -Fn`.quiet().text();
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}
