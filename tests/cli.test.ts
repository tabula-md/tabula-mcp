import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_HELP, collectDoctorChecks, formatDoctorReport, getPackageVersion, isDirectRun, parseCliOptions } from "../src/cli.js";

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
    expect(parseCliOptions([])).toEqual({ action: "serve", mode: "stdio", port: undefined, host: undefined });
  });

  it("enables HTTP mode with host and port flags", () => {
    expect(parseCliOptions(["--http", "--host", "127.0.0.1", "--port=3333"])).toEqual({
      mode: "http",
      action: "serve",
      host: "127.0.0.1",
      port: 3333,
    });
  });

  it("lets --stdio override --http for existing local MCP launchers", () => {
    expect(parseCliOptions(["--http", "--stdio"])).toMatchObject({ mode: "stdio" });
  });

  it("recognizes informational actions without changing the transport parser", () => {
    expect(parseCliOptions(["--help"]).action).toBe("help");
    expect(parseCliOptions(["--version"]).action).toBe("version");
    expect(parseCliOptions(["--doctor"]).action).toBe("doctor");
  });

  it("provides installable client commands in help", () => {
    expect(CLI_HELP).toContain("codex mcp add tabula -- npx -y @tabula-md/mcp@latest");
    expect(CLI_HELP).toContain("claude mcp add tabula -- npx -y @tabula-md/mcp@latest");
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps doctor output useful and secret-free", () => {
    const report = formatDoctorReport(collectDoctorChecks());
    expect(report).toContain("Node.js");
    expect(report).toContain("No room URLs, keys, Markdown, tokens, or share links");
    expect(report).not.toContain("#room=");
    expect(report).not.toContain("#json=");
  });
});
