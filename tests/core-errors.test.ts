import { describe, expect, it } from "vitest";
import { coreErrorContent, TabulaCoreError } from "../src/core-errors.js";

describe("public core error envelopes", () => {
  it("preserves recoverable Tabula errors as structured JSON", () => {
    const result = coreErrorContent(new TabulaCoreError("file_not_found", "Missing file.", {
      details: { path: "missing.md" },
      retry: "List files and retry.",
    }));
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "file_not_found",
      message: "Missing file.",
      path: "missing.md",
      retry: "List files and retry.",
    });
  });

  it("redacts unexpected internal messages behind one stable envelope", () => {
    const result = coreErrorContent(new Error("secret backend response"));
    const error = JSON.parse(result.content[0]!.text);
    expect(error).toMatchObject({ code: "internal_error", retry: expect.any(String) });
    expect(result.content[0]!.text).not.toContain("secret backend response");
  });
});
