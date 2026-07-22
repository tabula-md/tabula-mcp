import { describe, expect, it } from "vitest";
import {
  applyTextPatchesToString,
  areTextPatchesApplicable,
  getMarkdownOutline,
} from "../src/text.js";

describe("text patches", () => {
  it("applies non-overlapping patches in old-document coordinates", () => {
    const nextText = applyTextPatchesToString("alpha\nbeta\ngamma", [
      { from: 0, to: 5, insert: "ALPHA" },
      { from: 11, to: 16, insert: "GAMMA" },
    ]);

    expect(nextText).toBe("ALPHA\nbeta\nGAMMA");
  });

  it("rejects overlapping or out-of-range patches", () => {
    expect(areTextPatchesApplicable("abc", [{ from: 2, to: 4, insert: "" }])).toBe(false);
    expect(
      areTextPatchesApplicable("abc", [
        { from: 0, to: 2, insert: "x" },
        { from: 1, to: 3, insert: "y" },
      ]),
    ).toBe(false);
  });
});

describe("Markdown outline", () => {
  it("extracts Markdown headings with line numbers and offsets", () => {
    expect(getMarkdownOutline("# Title\nbody\n## Next")).toEqual([
      { depth: 1, text: "Title", line: 1, offset: 0 },
      { depth: 2, text: "Next", line: 3, offset: 13 },
    ]);
  });

  it("ignores headings inside fenced code while preserving source positions", () => {
    const markdown = [
      "# Visible",
      "```markdown",
      "## Hidden",
      "````",
      "~~~",
      "### Also hidden",
      "~~~",
      "###### Final",
    ].join("\r\n");

    expect(getMarkdownOutline(markdown)).toEqual([
      { depth: 1, text: "Visible", line: 1, offset: 0 },
      { depth: 6, text: "Final", line: 8, offset: markdown.indexOf("###### Final") },
    ]);
  });

  it("keeps headings hidden after an unclosed fence", () => {
    expect(getMarkdownOutline("# Visible\n```\n## Hidden")).toEqual([
      { depth: 1, text: "Visible", line: 1, offset: 0 },
    ]);
  });
});
