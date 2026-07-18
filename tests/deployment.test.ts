import { describe, expect, it } from "vitest";
import { resolveDeploymentMode } from "../src/deployment.js";

describe("deployment mode", () => {
  it("defaults locally and honors the explicit default for hosted adapters", () => {
    expect(resolveDeploymentMode({ env: {} })).toBe("local");
    expect(resolveDeploymentMode({ env: {}, defaultDeploymentMode: "remote" })).toBe("remote");
  });

  it("prefers an explicit option over environment configuration", () => {
    expect(resolveDeploymentMode({
      deploymentMode: "local",
      env: { TABULA_MCP_DEPLOYMENT_MODE: "remote", TABULA_MCP_REMOTE: "1" },
    })).toBe("local");
  });

  it("supports the configured mode and remote compatibility flag", () => {
    expect(resolveDeploymentMode({ env: { TABULA_MCP_DEPLOYMENT_MODE: "REMOTE" } })).toBe("remote");
    expect(resolveDeploymentMode({ env: { TABULA_MCP_REMOTE: "true" } })).toBe("remote");
  });
});
