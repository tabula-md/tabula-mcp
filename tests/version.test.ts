import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TABULA_MCP_VERSION } from "../src/version.js";

describe("Tabula MCP version", () => {
  it("keeps runtime metadata aligned with the package release", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };

    expect(TABULA_MCP_VERSION).toBe(packageJson.version);
  });
});
