import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES } from "../src/server/tool-metadata.js";

type RoutingFixture = {
  id: string;
  category: "must_tabula" | "should_tabula" | "must_not_tabula";
  expectedTool: string | null;
  prompt: string;
};

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/tool-routing-prompts.json", import.meta.url), "utf8"),
) as RoutingFixture[];

describe("tool routing evaluation fixtures", () => {
  it("covers positive, indirect, and negative selection boundaries", () => {
    expect(new Set(fixtures.map((fixture) => fixture.category))).toEqual(
      new Set(["must_tabula", "should_tabula", "must_not_tabula"]),
    );
    expect(fixtures.filter((fixture) => fixture.category === "must_tabula").length).toBeGreaterThanOrEqual(5);
    expect(fixtures.filter((fixture) => fixture.category === "must_not_tabula").length).toBeGreaterThanOrEqual(5);
  });

  it("references only current Tabula tools and contains no real bearer secrets", () => {
    for (const fixture of fixtures) {
      if (fixture.expectedTool) expect(CORE_TOOL_NAMES).toContain(fixture.expectedTool);
      expect(fixture.prompt).not.toMatch(/#(?:room|json)=[A-Za-z0-9_-]{12,},[A-Za-z0-9_-]{12,}/);
    }
  });
});
