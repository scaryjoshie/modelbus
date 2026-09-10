/**
 * Default text for a host that accepts plain text: one attribution line, a blank
 * line, then the body unchanged. `marker` is a substring of that text a transcript
 * watcher can look for. Hosts with richer input need not use this.
 */
export function attributed(o: { message: { id: string; body: string }; from: { name: string } }): {
  text: string;
  marker: string;
} {
  const marker = `#${o.message.id}`;
  return { text: `[modelbus ${marker}] from ${o.from.name}\n\n${o.message.body}`, marker };
}
