# Experiment: does a host keep a queued message across quit and resume?

Status: not yet run (2026-09-10). Decides whether redelivery after `delivered` is
safe per host. Written for a computer-use agent; a person can follow it too.

---

You are testing whether coding-agent hosts keep a queued message across a quit and resume.
Do not touch any existing terminal windows, tabs, or agent sessions. Open your own new
terminal window and work only there. Do not send messages to any agent except the ones
you create. Work in a fresh directory: `mkdir -p /tmp/modelbus-queue-test` and `cd` there.
Define a shell function for every modelbus command, with the path of this checkout:
`mb() { bun run <path-to-modelbus>/src/cli.ts "$@"; }` (a function, not a variable: zsh
does not split variables into words).

For each host below, do these steps and record the result.

1. Start the host in that directory (commands below). Wait until it is ready for input.
2. In a second tab of YOUR window, run: `mb who --fresh`
   Find the row whose cwd ends in `tmp/modelbus-queue-test` (or whose name starts with
   `modelbus-queue-test`). Record its name as NAME.
3. In the host, type a task that keeps it busy for about 90 seconds, e.g.
   "Run the shell command `sleep 90` and then reply with the single word done."
   Confirm it has started working.
4. While it is busy, in your second tab run:
   `mb send --as tester --to "NAME" "queue test 1"`
   Then: `mb log | tail -3` and record the status of the message (expect: delivered).
5. Before the task finishes (within 60 seconds), quit the host abruptly: press Ctrl+C
   twice, and if it is still running, close that tab.
6. Resume the same session with the resume command below. Wait 20 seconds.
7. Record: did the text "queue test 1" appear in the resumed session on its own?
   Run: `mb log | tail -3` and record the status again (read means it was consumed).
8. Quit the host normally.

Hosts:

- Claude Code: start with `claude`. Resume with `claude --resume` and pick the most
  recent session in this directory, or `claude -c`.
- Codex: start with `codex`. Before step 3, give it one trivial turn first ("say hi"),
  because Codex cannot be messaged before its first turn. Resume with `codex resume`
  and pick the most recent thread.

Report, per host: KEPT (message appeared after resume and log says read),
DROPPED (log stayed delivered and nothing appeared), or UNCLEAR, plus the two log lines.
Do not attempt Aside. Do not modify any files outside `/tmp/modelbus-queue-test`.

---

## Results

(fill in)

| Host | Result | Log before quit | Log after resume |
|---|---|---|---|
| Claude Code | | | |
| Codex | | | |
