import { describe, expect, it, vi } from "vitest";
import {
  errorMessageForLog,
  logOperationalError,
  redactOperationalText,
  sanitizeOperationalLogEntry,
  type OperationalPolicy,
} from "../src/server/operational-policy.js";

const policy: OperationalPolicy = {
  allowRemoteRoomConnections: true,
  authToken: null,
  logLevel: "error",
  maxActiveSessions: 10,
  maxRequestBytes: 1024,
  production: true,
  publicUnauthenticated: false,
  rateLimitMax: 10,
  rateLimitWindowMs: 1000,
  requestTimeoutMs: 1000,
  sessionIdleTtlMs: 1000,
  statelessHttp: false,
};

describe("operational log redaction", () => {
  it("redacts bearer tokens and Tabula URL fragments", () => {
    const value = "Bearer token-123 https://tabula.md/#room=id,key https://tabula.md/#json=id,key";
    const redacted = redactOperationalText(value);
    expect(redacted).not.toContain("token-123");
    expect(redacted).not.toContain("id,key");
    expect(redacted).toContain("#room=[redacted]");
    expect(redacted).toContain("#json=[redacted]");
  });

  it("redacts sensitive fields even when they do not look like URLs", () => {
    expect(sanitizeOperationalLogEntry({ roomKey: "secret-room-key", authorization: "opaque", detail: "safe" }))
      .toEqual({ roomKey: "[redacted]", authorization: "[redacted]", detail: "safe" });
  });

  it("sanitizes errors and serialized operational entries", () => {
    const error = new Error("failed for https://tabula.md/#room=room-id,room-secret");
    expect(errorMessageForLog(error)).not.toContain("room-secret");

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      logOperationalError(policy, "test_failure", {
        error: error.message,
        snapshotKey: "snapshot-secret",
      });
      const output = String(consoleError.mock.calls[0]?.[0]);
      expect(output).not.toContain("room-secret");
      expect(output).not.toContain("snapshot-secret");
      expect(output).toContain("[redacted]");
    } finally {
      consoleError.mockRestore();
    }
  });
});
