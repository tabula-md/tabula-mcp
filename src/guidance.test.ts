import { describe, expect, it } from "vitest";
import { formatTabulaReadMe, getTabulaReadMe, tabulaReadMeTopics } from "./guidance.js";

describe("Tabula read_me guidance", () => {
  it("returns guidance for every supported topic", () => {
    for (const topic of tabulaReadMeTopics) {
      const readMe = getTabulaReadMe(topic);

      expect(readMe.product).toBe("Tabula.md");
      expect(readMe.topic).toBe(topic);
      expect(readMe.summary.length).toBeGreaterThan(40);
      expect(readMe.nextActions.length).toBeGreaterThan(0);
      expect(readMe.securityRules.join("\n")).toContain("#key");
    }
  });

  it("formats model-facing guidance with next actions and security rules", () => {
    const text = formatTabulaReadMe(getTabulaReadMe("sharing"));

    expect(text).toContain("Tabula.md MCP read_me (sharing)");
    expect(text).toContain("Next actions:");
    expect(text).toContain("Security rules:");
    expect(text).toContain("encrypted room links");
    expect(text).toContain("bearer secret");
  });
});
