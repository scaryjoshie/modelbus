# Subagent detection: evidence and first experiment

Read-only inspection, 2026-09-07. The experiment below is a proposal, not an
implemented detector or a completed runtime test. No agents were spawned, messages
sent, hooks installed, or host configurations changed for this investigation.

## What works today

The current scanner identifies hosts and candidate sessions. It does **not** classify
top-level sessions versus subagents: `LiveSession` has no relationship or parent
field. Detecting a provider, identifying a child, establishing current activity, and
attributing an MCP call to that child are separate capabilities.

| Provider | Current code | Evidence available locally | Assessment |
|---|---|---|---|
| Aside | Reads non-archived, non-ephemeral sessions, capped at 50 per account; ignores parent/origin fields | `sessions.parent_id`, `trigger.type = "subagent"`, separate `branched_from`, host status | Explicit child evidence in existing records; straightforward classification experiment |
| Codex | Generic executable + TTY scan, one row per process; no thread identity | Thread `source` includes `subagent.thread_spawn.parent_thread_id`; rollout metadata also has parent and agent path | Explicit child evidence in sampled records; needs a real Codex thread detector |
| Claude Code | Reads per-process session registry; does not inspect children | Nested child transcripts carry `agentId`, parent `sessionId`, and `isSidechain`; documented lifecycle hooks | Good evidence for child identity; current activity and team variants need separate validation |
| Other hosts | Generic process scan where supported | No relationship investigation yet | Unknown; do not infer root status from executable or TTY |

These findings establish plausible classification rules, not a measured accuracy
rate or comprehensive coverage across versions and host modes.

## Aside

Across the local account databases, seven stored sessions had both a non-null
`parent_id` and a parsed `trigger` with `type: "subagent"`. All seven had
`ephemeral = 0` and no archive timestamp, so they pass the current scanner's filter.
Filtering ephemeral sessions does not exclude subagents.

Use the explicit trigger type and parent reference together. Preserve account scope
when identifying sessions. `branched_from` is a separate field: a copied or branched
conversation must not automatically be treated as a delegated helper. The sampled
children had no branch reference; branch behavior still needs a controlled example.

All sampled children were stored as idle. Their existence does not prove they are
currently running, open on screen, or independently reachable. A healthy shared
daemon also does not prove every saved session is live. These fields are undocumented
local implementation details, so unknown/new trigger types require explicit handling.

## Codex

Local `state_5.sqlite` contains subagent origins. Sampled child rollouts explicitly
name their parent thread and agent path. Earlier inspection also found a single
Codex process holding a root thread and three child threads, so one PID is not one
conversation. The current process-only scanner misses that distinction entirely.

Prefer explicit subagent origin metadata. A `forked_from_id` alone is insufficient:
fork ancestry and delegated-agent relationships should be tested separately. Preserve
parent IDs when known; a recognized subagent need not have a recoverable parent in
every historical format. Missing or unfamiliar metadata remains unknown.

Thread records persist after work finishes. Combine thread identity with native
runtime evidence where available, and report unknown activity when it is unavailable.
An open file or thread lock should not be presented as proof the child is executing
a turn. The official [Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
describes `/agent` for inspecting CLI threads; it can provide an independent comparison
during the experiment. Local storage fields above were observed directly, not taken
as a public storage contract.

## Claude Code

Sampled files under
`~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl` contained
`agentId`, the parent `sessionId`, and `isSidechain: true`. This provides child identity
even when no separate PID exists. `parentUuid` in a transcript links messages; it is
not the parent agent's identity. Child transcript existence is historical evidence,
not proof that the child is still running.

The official [hook reference](https://code.claude.com/docs/en/hooks#subagentstart)
documents `SubagentStart` and `SubagentStop`, with session and agent IDs. These offer
a lifecycle experiment if passive metadata cannot establish activity. Common hook
inputs also identify calls inside a subagent using `agent_id`. Hooks have not been
installed or validated locally for modelbus.

Ordinary subagents and agent-team teammates need distinct test cases. Teams can run
in one terminal or separate panes; the [team documentation](https://code.claude.com/docs/en/agent-teams#architecture)
also describes local team configuration with member identities. Do not assume every
separate Claude process is an independent user-started root, or claim team-mode
coverage from a successful ordinary-subagent test.

Some subagents [share the parent's MCP connection](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent).
Recognizing a child in storage does not tell an MCP server which conversation made
a particular call. Hook agent IDs suggest another source of evidence, but correlating
those with MCP calls is a separate untested step.

## Proposed first setup

Start with a flat CLI diagnostic view and JSON output. Each provider reports the
same small set of facts: provider, native session identity, relationship
(`top-level`, `subagent`, or `unknown`), optional parent identity, activity evidence,
and the source of its classification. Exact field names remain a proposal.
Normal peer discovery should expose only supported top-level candidates; diagnostics
can show children and unknowns without making them message targets or building a UI tree.

1. Capture small metadata fixtures from observed roots and children for each host.
   Strip prompts, conversation bodies, tokens, and unrelated session data. Check
   explicit child origins, missing/unknown metadata, and branches/forks. These
   fixtures test parsing and classification, not live-session detection.
2. In a scratch workspace, use two independent top-level sessions of one provider
   in the same directory. Have each create one harmless, named native subagent.
   Keep a child active long enough to observe it, then let it finish normally.
   Repeat for Aside, Codex, and Claude Code. Compare the diagnostic rows and parent
   links against the host's own session/agent view or native creation result.
3. Check snapshots before spawn, while active, and after completion. Both roots must
   remain distinct; children must link to the correct root and never become new
   peers. If activity cannot be verified, display unknown rather than infer running
   from a persisted transcript. No crash detection or recovery is needed.
4. Include an ordinary session fork/branch as a negative case where supported.
   Exercise Claude foreground/background subagents; test team modes separately if
   they are needed locally, otherwise record them as unverified coverage.
5. After classification works, use a diagnostic MCP identity tool to test parent and
   child callers, including concurrent calls on a shared connection. It should report
   observed binding evidence or ambiguity. It must not send messages or silently
   claim that a child's call came from its parent. Final identity handling remains OPEN.

The first milestone is reliable separation of top-level peers from observed helpers,
with honest unknowns. Full subagent display, addressing, management, and automatic
recovery remain outside v0. The identity probe is a later gate before real message
routing; detecting the correct parent tree alone is not sufficient to pass it.
