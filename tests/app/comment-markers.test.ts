import { describe, expect, it } from "vitest";
import {
  extractCommentMarkers,
  formatCommentContextMessage,
} from "../../src/app/comment-markers.js";

describe("comment markers", () => {
  it("extracts Tabula comment markers from Markdown", () => {
    const comments = extractCommentMarkers(
      "# Draft\n\n<!-- tabula-comment: tighten intro -->\n\n> [!comment] verify this claim",
    );

    expect(comments).toEqual([
      expect.objectContaining({
        line: 3,
        text: "tighten intro",
        marker: "html-comment",
      }),
      expect.objectContaining({
        line: 5,
        text: "verify this claim",
        marker: "comment-callout",
      }),
    ]);
  });

  it("ignores empty comment markers", () => {
    expect(extractCommentMarkers("<!-- tabula-comment: -->\n> [!comment] ")).toEqual([]);
  });

  it("formats a bounded model context message for a selected comment", () => {
    const message = formatCommentContextMessage({
      title: "Draft",
      source: "document",
      sha256: "abc123",
      comment: {
        id: "comment-1-1",
        line: 7,
        offset: 42,
        text: "Review this section",
        marker: "comment-callout",
      },
    });

    expect(message).toContain('Tabula.md comment from document "Draft".');
    expect(message).toContain("Line: 7");
    expect(message).toContain("Hash: abc123");
    expect(message).toContain("Review this section");
  });
});
