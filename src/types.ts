/**
 * Core types for the live-session detector.
 *
 * A LiveSession is something running on this machine right now that an agent
 * could plausibly be. It is *detection*, not membership: seeing a session does
 * not mean modelbus can message it. `reach` records how we could deliver to it.
 */

export type HostKind =
  | "claude-code"
  | "codex"
  | "aside"
  | "gemini"
  | "opencode"
  | "goose"
  | "aider"
  | "cursor-agent"
  | "copilot"
  | "hermes"
  | "unknown";

/** How the daemon could deliver a message into this session. Ordered best-first. */
export type Reach =
  | "claude-socket" // Claude Code cross-session messaging socket
  | "aside-mcp" // Aside as MCP client + heartbeat/event routine
  | "cmux-send" // cmux `send --surface` text injection
  | "tmux-paste" // tmux send-keys (not installed here yet)
  | "pull-only"; // only reachable if it calls sync() itself

export interface TerminalLocation {
  multiplexer: "cmux" | "tmux";
  tty: string;
  /** cmux: workspace:N, tmux: session name */
  workspace: string;
  workspaceTitle?: string;
  /** cmux: pane:N / surface:N, tmux: window.pane */
  pane?: string;
  surface?: string;
  surfaceTitle?: string;
}

export interface LiveSession {
  host: HostKind;
  /** Best available human name: Claude Code registry name, Aside title, or host+pid. */
  name: string;
  pid?: number;
  tty?: string;
  cwd?: string;
  /** Host-reported status if any (Claude Code: idle/busy; Aside: idle/running). */
  status?: string;
  /** Host-specific stable id (Claude Code sessionId, Aside session id). */
  sessionId?: string;
  startedAt?: number;
  terminal?: TerminalLocation;
  reach: Reach[];
  /** Anything host-specific worth surfacing, kept small. */
  extra?: Record<string, string | number | boolean | undefined>;
}

export interface Provider {
  kind: HostKind;
  /** Return every live session this provider can see. Must never throw; return [] instead. */
  detect(): Promise<LiveSession[]>;
}
