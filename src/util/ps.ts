import { $ } from "bun";

/** Small process-table helpers shared by providers. */

export interface ProcInfo {
  pid: number;
  ppid: number;
  tty?: string;
  startedAt?: number;
  args: string;
  /** basename of argv[0] */
  exe: string;
}

const PROCESS_CACHE_MS = 1000;
let cache: { at: number; procs: ProcInfo[] } | undefined;

/** Snapshot of the process table, cached for one second. */
export async function listProcesses(): Promise<ProcInfo[]> {
  if (cache && Date.now() - cache.at < PROCESS_CACHE_MS) return cache.procs;
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

/** Working directory of a process via lsof, or undefined. */
export async function cwdOf(pid: number): Promise<string | undefined> {
  try {
    const out = await $`lsof -a -p ${pid} -d cwd -Fn`.quiet().text();
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

export interface Ancestor {
  pid: number;
  ppid: number;
  comm: string;
}

/** This process's ancestors, nearest first, up to `max` levels. */
export async function ancestors(startPid: number = process.pid, max = 12): Promise<Ancestor[]> {
  const out: Ancestor[] = [];
  let pid = startPid;
  for (let i = 0; i < max && pid > 1; i++) {
    let line: string;
    try {
      line = (await $`ps -o pid=,ppid=,comm= -p ${pid}`.quiet().text()).trim();
    } catch {
      break;
    }
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) break;
    const a = { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] ?? "" };
    out.push(a);
    pid = a.ppid;
  }
  return out;
}
