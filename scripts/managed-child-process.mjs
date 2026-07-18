import { once } from "node:events";
import { spawn } from "node:child_process";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const signalProcessTree = async (child, signal) => {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const taskkill = spawn("taskkill", args, { stdio: "ignore" });
    await once(taskkill, "exit").catch(() => undefined);
    return;
  }

  try {
    // spawnLogged starts each service in its own process group. Signalling the
    // negative pid terminates npm, npx, Java, Vite, and their other descendants.
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
};

export const spawnLogged = ({ command, args, cwd, env, label }) => {
  let stopping = false;
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });
  child.once("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    if (code !== 0 && code !== null) {
      process.stderr.write(`[${label}] exited with code ${code}\n${stdout.join("")}${stderr.join("")}\n`);
    } else if (signal) {
      process.stderr.write(`[${label}] exited with signal ${signal}\n`);
    }
  });
  child.once("error", (error) => {
    process.stderr.write(`[${label}] failed to start: ${error.message}\n`);
  });
  return {
    child,
    stdout,
    stderr,
    label,
    markStopping() {
      stopping = true;
    },
  };
};

export const stopProcess = async (processInfo, { gracePeriodMs = 5_000 } = {}) => {
  if (!processInfo?.child) {
    return;
  }

  const { child } = processInfo;
  processInfo.markStopping?.();
  const exited = child.exitCode === null && child.signalCode === null
    ? once(child, "exit").then(() => true)
    : Promise.resolve(true);

  await signalProcessTree(child, "SIGTERM");
  const exitedGracefully = await Promise.race([
    exited,
    wait(gracePeriodMs).then(() => false),
  ]);

  if (!exitedGracefully) {
    await signalProcessTree(child, "SIGKILL");
    await Promise.race([exited, wait(1_000)]);
  }

  // A descendant that inherited these pipes can otherwise keep the test
  // runner alive even after the npm wrapper exits.
  child.stdout?.destroy();
  child.stderr?.destroy();
};
