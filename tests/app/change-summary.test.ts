import { describe, expect, it } from "vitest";
import {
  createMarkdownChangeSummary,
  extractHeadingLabels,
  formatDocumentChangeMessage,
} from "../../src/app/change-summary.js";

describe("document change summaries", () => {
  it("extracts Markdown heading labels with depth", () => {
    expect(extractHeadingLabels("# Title\n\n## Section").map((heading) => heading.label)).toEqual([
      "# Title",
      "## Section",
    ]);
  });

  it("summarizes changed ranges and outline changes", () => {
    const summary = createMarkdownChangeSummary(
      "# Draft\n\nOld body",
      "# Draft\n\n## Plan\n\nNew body",
    );

    expect(summary.changed).toBe(true);
    expect(summary.changedRange.previousStart).toBeGreaterThan(0);
    expect(summary.removedChars).toBeGreaterThan(0);
    expect(summary.addedChars).toBeGreaterThan(0);
    expect(summary.currentExcerpt).toContain("## Plan");
    expect(summary.outline.added).toEqual(["## Plan"]);
  });

  it("truncates large changed excerpts", () => {
    const summary = createMarkdownChangeSummary("", "x".repeat(4000), { maxExcerptChars: 120 });

    expect(summary.truncated).toBe(true);
    expect(summary.currentExcerpt).toContain("[truncated]");
    expect(summary.currentExcerpt.length).toBeLessThan(180);
  });

  it("formats model context without requiring the full document", () => {
    const summary = createMarkdownChangeSummary("old", "new");
    const message = formatDocumentChangeMessage({
      title: "Draft",
      documentId: "doc-1",
      baseSha256: "abc123",
      summary,
    });

    expect(message).toContain('User edited Tabula.md document "Draft".');
    expect(message).toContain("Document id: doc-1");
    expect(message).toContain("Base saved hash: abc123");
    expect(message).toContain("Current changed excerpt");
  });
});
