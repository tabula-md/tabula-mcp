import { describe, expect, it } from "vitest";
import { assertMarkdownSize, maxMarkdownFileBytes } from "../src/markdown-limits.js";

describe("Markdown file limits", () => {
  it("accepts the byte boundary and rejects larger UTF-8 content", () => {
    expect(() => assertMarkdownSize("a".repeat(maxMarkdownFileBytes))).not.toThrow();
    expect(() => assertMarkdownSize(`${"a".repeat(maxMarkdownFileBytes - 1)}한`)).toThrow(/5 MiB/);
  });
});
