import { describe, expect, it } from "vitest";
import { createSessionAgentIdentity } from "../src/agent-identity.js";

describe("session agent identity", () => {
  it("keeps one actor id while adapting the display name to the MCP client", () => {
    const resolve = createSessionAgentIdentity({ id: "stable-agent" });
    expect(resolve("claude-desktop")).toEqual({ id: "stable-agent", name: "Claude" });
    expect(resolve("OpenAI Codex")).toEqual({ id: "stable-agent", name: "Codex" });
    expect(resolve("unknown-client")).toEqual({ id: "stable-agent", name: "Tabula Agent" });
  });

  it("honors explicit operator identity overrides", () => {
    const resolve = createSessionAgentIdentity({
      env: {
        TABULA_MCP_ACTOR_NAME: "Research Agent",
        TABULA_MCP_ACTOR_COLOR: "#123456",
      },
      id: "operator-agent",
    });
    expect(resolve("claude")).toEqual({
      id: "operator-agent",
      name: "Research Agent",
      color: "#123456",
    });
  });
});
