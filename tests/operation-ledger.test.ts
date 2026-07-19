import { describe, expect, it } from "vitest";
import { currentOperationId, OperationLedger } from "../src/server/operation-ledger.js";
import { markOperationCommitted, runWithOperationSignal } from "../src/server/operation-context.js";
import { withTimeout } from "../src/server/operational-policy.js";

describe("operation result ledger", () => {
  it("deduplicates equivalent in-flight and settled retries", async () => {
    const ledger = new OperationLedger();
    let calls = 0;
    const operation = () => ledger.run("edit_file", {
      sessionId: "session",
      path: "README.md",
      edits: [{ oldText: "old", newText: "new" }],
    }, async () => ({ call: ++calls }));

    const [first, second] = await Promise.all([operation(), operation()]);
    expect(first).toEqual({ call: 1 });
    expect(second).toEqual({ call: 1 });
    await expect(operation()).resolves.toEqual({ call: 1 });
  });

  it("coalesces only concurrent calls when settled state must be refreshed", async () => {
    const ledger = new OperationLedger();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = () => ledger.runInFlight("join_room", { roomUrl: "private" }, async () => {
      calls += 1;
      await gate;
      return { call: calls };
    });

    const first = operation();
    const concurrent = operation();
    release?.();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([{ call: 1 }, { call: 1 }]);
    await expect(operation()).resolves.toEqual({ call: 2 });
  });

  it("allows retry after a pre-commit failure and expires completed results", async () => {
    let now = 0;
    const ledger = new OperationLedger({ ttlMs: 10, now: () => now });
    let calls = 0;
    const run = (fail = false) => ledger.run("write_file", { path: "README.md", content: "same" }, async () => {
      calls += 1;
      if (fail) throw new Error("before commit");
      return calls;
    });

    await expect(run(true)).rejects.toThrow("before commit");
    await expect(run()).resolves.toBe(2);
    now = 11;
    await expect(run()).resolves.toBe(3);
  });

  it("keeps a private operation id stable across an ambiguous retry", async () => {
    const ledger = new OperationLedger();
    const ids: string[] = [];
    const run = (fail: boolean) => ledger.run("export_copy", { files: [{ path: "a.md", content: "secret" }] }, async () => {
      ids.push(currentOperationId() ?? "");
      if (fail) throw new Error("response lost");
      return "recovered";
    });

    await expect(run(true)).rejects.toThrow("response lost");
    await expect(run(false)).resolves.toBe("recovered");
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[0]).not.toContain("secret");
  });

  it("returns the original result when a committed operation is retried after timeout", async () => {
    const ledger = new OperationLedger();
    let applies = 0;
    const input = { sessionId: "session", path: "README.md", content: "target" };
    const operation = () => ledger.run("write_file", input, async () => {
      applies += 1;
      markOperationCommitted("workspace_change");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { applied: true, revision: "new" };
    });

    await expect(withTimeout((signal) => runWithOperationSignal(signal, operation), 5))
      .rejects.toMatchObject({ committed: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(withTimeout((signal) => runWithOperationSignal(signal, operation), 100))
      .resolves.toEqual({ applied: true, revision: "new" });
    expect(applies).toBe(1);
  });
});
