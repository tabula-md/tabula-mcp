import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectRun, parseCliOptions } from "../src/cli.js";

describe("CLI entrypoint detection", () => {
  it("recognizes direct execution through a symlinked path", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "tabula-mcp-cli-"));
    const target = path.join(tempDir, "index.js");
    const link = path.join(tempDir, "linked-index.js");

    try {
      writeFileSync(target, "export {};\n", "utf8");
      try {
        symlinkSync(target, link);
      } catch {
        return;
      }

      expect(existsSync(link)).toBe(true);
      expect(isDirectRun(pathToFileURL(realpathSync(target)).href, ["node", link])).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns false when there is no entrypoint argv", () => {
    expect(isDirectRun(import.meta.url, ["node"])).toBe(false);
  });
});

describe("CLI options", () => {
  it("defaults to stdio mode", () => {
    expect(parseCliOptions([])).toEqual({ mode: "stdio", port: undefined, host: undefined });
  });

  it("enables HTTP mode with host and port flags", () => {
    expect(parseCliOptions(["--http", "--host", "127.0.0.1", "--port=3333"])).toEqual({
      mode: "http",
      host: "127.0.0.1",
      port: 3333,
    });
  });

  it("lets --stdio override --http for existing local MCP launchers", () => {
    expect(parseCliOptions(["--http", "--stdio"])).toMatchObject({ mode: "stdio" });
  });
});
