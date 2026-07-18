import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnLogged, stopProcess } from "../scripts/managed-child-process.mjs";

describe.skipIf(process.platform === "win32")("managed child processes", () => {
  it("terminates descendants that inherit the service pipes", async () => {
    const processInfo = spawnLogged({
      command: process.execPath,
      args: [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      cwd: process.cwd(),
      env: {},
      label: "process-tree-fixture",
    });

    const stdoutClosed = once(processInfo.child.stdout, "close");
    const stderrClosed = once(processInfo.child.stderr, "close");

    await stopProcess(processInfo, { gracePeriodMs: 500 });

    await expect(Promise.all([stdoutClosed, stderrClosed])).resolves.toBeDefined();
    expect(processInfo.child.exitCode !== null || processInfo.child.signalCode !== null).toBe(true);
  });
});
