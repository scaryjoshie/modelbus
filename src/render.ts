/** One inbox item as an agent reads it: `name: text`, continuation lines indented. */
export function renderItem(i: { fromName: string; body: string }): string {
  const [first = "", ...rest] = i.body.split("\n");
  return [`${i.fromName}: ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
}
