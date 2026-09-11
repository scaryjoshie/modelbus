/**
 * Default text for a host that accepts plain text: one attribution line, a blank
 * line, then the body unchanged. `marker` is a substring of that text a transcript
 * watcher can look for. Hosts with richer input need not use this.
 *
 *   [modelbus #k3f2] reviewer (xxPNE8o) → you
 *   [modelbus #k3f2] reviewer (xxPNE8o) → #backend
 */
export function attributed(o: {
  message: { id: string; body: string };
  from: { id: string; name: string };
  conversation: { kind: string; name: string | null };
}): { text: string; marker: string } {
  const marker = `#${o.message.id}`;
  const to = o.conversation.kind === "group" ? `#${o.conversation.name ?? "?"}` : "you";
  return {
    text: `[modelbus ${marker}] ${o.from.name} (${o.from.id}) → ${to}\n\n${o.message.body}`,
    marker,
  };
}
