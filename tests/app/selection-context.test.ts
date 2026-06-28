import { describe, expect, it } from "vitest";
import {
  createSelectionContext,
  formatSelectionContextMessage,
} from "../../src/app/selection-context.js";

describe("selection context", () => {
  it("keeps short selections exact", () => {
    const selection = createSelectionContext("Selected Markdown", { maxChars: 100 });

    expect(selection).toEqual({
      text: "Selected Markdown",
      originalLength: "Selected Markdown".length,
      excerptLength: "Selected Markdown".length,
      truncated: false,
    });
  });

  it("truncates long selections without keeping the full text", () => {
    const selectedText = `start ${"middle ".repeat(200)}end`;
    const selection = createSelectionContext(selectedText, { maxChars: 120 });

    expect(selection.truncated).toBe(true);
    expect(selection.originalLength).toBe(selectedText.length);
    expect(selection.text).toContain("[truncated selection]");
    expect(selection.text).toContain("start");
    expect(selection.text).toContain("end");
    expect(selection.text).not.toContain("middle ".repeat(100));
    expect(selection.excerptLength).toBe(selection.text.length);
  });

  it("formats model context with truncation metadata", () => {
    const selection = createSelectionContext("x".repeat(1000), { maxChars: 80 });
    const message = formatSelectionContextMessage({
      source: "document Draft",
      sha256: "abc123",
      selection,
    });

    expect(message).toContain("Selected Tabula.md text from document Draft at abc123.");
    expect(message).toContain("Selection excerpt:");
    expect(message).toContain("Selection output was truncated");
    expect(message).toContain("```markdown");
  });
});
