import { describe, expect, test } from "bun:test";
import { isDeliveredEntry } from "./claude-code-wake.ts";

describe("transcript receipt detection", () => {
  test("queue-operation remove counts", () => {
    expect(isDeliveredEntry(JSON.stringify({ type: "queue-operation", operation: "remove" }))).toBe(
      true,
    );
    expect(
      isDeliveredEntry(JSON.stringify({ type: "queue-operation", operation: "enqueue" })),
    ).toBe(false);
  });
  test("user entry counts, others do not", () => {
    expect(
      isDeliveredEntry(
        JSON.stringify({ type: "user", message: { role: "user", content: "[modelbus #x] hi" } }),
      ),
    ).toBe(true);
    expect(isDeliveredEntry(JSON.stringify({ type: "system" }))).toBe(false);
    expect(isDeliveredEntry(JSON.stringify({ type: "assistant" }))).toBe(false);
    expect(isDeliveredEntry("not json")).toBe(false);
  });
});
