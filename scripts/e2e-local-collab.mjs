import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoomRepoDir = path.resolve(rootDir, "../tabula-room");
const defaultTabulaMdRepoDir = path.resolve(rootDir, "../marker 2");
const defaultServerEntrypoint = path.join(rootDir, "dist", "index.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv) => {
  const parsed = {
    roomRepoDir: process.env.TABULA_ROOM_REPO_DIR || defaultRoomRepoDir,
    tabulaMdRepoDir: process.env.TABULA_MD_REPO_DIR || defaultTabulaMdRepoDir,
    serverEntrypoint: process.env.TABULA_MCP_SERVER_ENTRYPOINT || defaultServerEntrypoint,
    headed: process.env.TABULA_E2E_HEADED === "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--room-repo-dir") {
      if (!next) {
        throw new Error("--room-repo-dir requires a value");
      }
      parsed.roomRepoDir = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--tabula-md-repo-dir") {
      if (!next) {
        throw new Error("--tabula-md-repo-dir requires a value");
      }
      parsed.tabulaMdRepoDir = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--server-entrypoint") {
      if (!next) {
        throw new Error("--server-entrypoint requires a value");
      }
      parsed.serverEntrypoint = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--headed") {
      parsed.headed = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
};

const getFreePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "free-port probe should listen on TCP");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
};

const spawnLogged = ({ command, args, cwd, env, label }) => {
  let stopping = false;
  const child = spawn(command, args, {
    cwd,
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

const stopProcess = async (processInfo) => {
  if (!processInfo?.child || processInfo.child.killed || processInfo.child.exitCode !== null) {
    return;
  }
  processInfo.markStopping?.();
  processInfo.child.kill("SIGTERM");
  await Promise.race([
    once(processInfo.child, "exit"),
    wait(5_000).then(() => {
      if (!processInfo.child.killed && processInfo.child.exitCode === null) {
        processInfo.child.kill("SIGKILL");
      }
    }),
  ]);
};

const waitForHttp = async (url, { timeoutMs = 30_000, label = url } = {}) => {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError}`);
};

const waitForTcp = async (port, { timeoutMs = 60_000, label = String(port) } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const textFromTool = (result) =>
  result.content?.find((item) => item.type === "text")?.text ?? "";

const redactRoomUrl = (roomUrl) => {
  try {
    const url = new URL(roomUrl);
    const roomValue = url.hash.replace(/^#room=/, "");
    const [roomId] = roomValue.split(",");
    return `${url.origin}/#room=${roomId || "..."},...`;
  } catch {
    return "[invalid-room-url]";
  }
};

const callTool = async (client, name, args = {}) => {
  const result = await client.callTool({
    name,
    arguments: args,
  });
  assert.notEqual(result.isError, true, `${name} failed: ${textFromTool(result)}`);
  assert(result.structuredContent, `${name} should return structuredContent`);
  return result.structuredContent;
};

const withMcpClient = async ({ serverEntrypoint, roomUrl, appOrigin, firebaseConfig }, callback) => {
  const client = new Client({ name: "tabula-mcp-local-e2e", version: "0.0.0" });
  const env = {
    ...process.env,
    TABULA_ROOM_URL: roomUrl,
    TABULA_APP_ORIGIN: appOrigin,
    TABULA_MCP_ALLOW_ANY_EGRESS: "1",
  };
  if (firebaseConfig) {
    Object.assign(env, {
      TABULA_MCP_FIREBASE_CONFIG: firebaseConfig,
      TABULA_MCP_FIREBASE_EMULATOR_HOST: "127.0.0.1",
      TABULA_MCP_FIRESTORE_EMULATOR_PORT: "8080",
      TABULA_MCP_FIREBASE_STORAGE_EMULATOR_PORT: "9199",
    });
  } else {
    delete env.TABULA_MCP_FIREBASE_CONFIG;
    delete env.TABULA_FIREBASE_CONFIG;
    delete env.VITE_TABULA_FIREBASE_CONFIG;
    delete env.TABULA_MCP_FIREBASE_EMULATOR_HOST;
    delete env.TABULA_MCP_FIRESTORE_EMULATOR_PORT;
    delete env.TABULA_MCP_FIREBASE_STORAGE_EMULATOR_PORT;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    cwd: rootDir,
    env,
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
    const unexpectedStderr = stderr
      .join("")
      .split("\n")
      .filter(
        (line) =>
          line.trim() &&
          !line.includes("ExperimentalWarning: localStorage is not available") &&
          !line.includes("Use `node --trace-warnings ...` to show where the warning was created"),
      );
    assert.equal(unexpectedStderr.join("\n"), "", `MCP stdio server wrote unexpected stderr: ${unexpectedStderr.join("\n")}`);
  }
};

const pageEditorText = async (page) =>
  page.$$eval(".cm-content .cm-line", (lines) => lines.map((line) => line.textContent ?? "").join("\n"));

const waitForEditorText = async (page, expected, timeoutMs = 15_000) => {
  const startedAt = Date.now();
  let latest = "";
  while (Date.now() - startedAt < timeoutMs) {
    latest = await pageEditorText(page).catch(() => "");
    if (latest.includes(expected)) {
      return latest;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for editor text ${JSON.stringify(expected)}. Latest text:\n${latest}`);
};

const tabTitles = async (page) =>
  page.$$eval(".tab-item", (tabs) =>
    tabs.map((tab) => ({
      title: tab.getAttribute("data-file-name") ?? tab.querySelector(".tab-title")?.textContent?.trim() ?? "",
      visibleTitle: tab.querySelector(".tab-title")?.textContent?.trim() ?? "",
      active: tab.classList.contains("active"),
      live: tab.classList.contains("live"),
    })),
  );

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  const roomPort = await getFreePort();
  const appPort = await getFreePort();
  const peerOnlyAppPort = await getFreePort();
  const roomUrl = `http://127.0.0.1:${roomPort}`;
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const peerOnlyAppOrigin = `http://127.0.0.1:${peerOnlyAppPort}`;
  let roomServer;
  let appServer;
  let peerOnlyAppServer;
  let firebaseServer;
  let browser;
  const firebaseConfig = JSON.stringify({
    apiKey: "tabula-local",
    authDomain: "tabula-local.firebaseapp.com",
    projectId: "tabula-local",
    storageBucket: "tabula-local.appspot.com",
    appId: "tabula-local",
  });

  try {
    roomServer = spawnLogged({
      command: "npm",
      args: ["run", "dev"],
      cwd: options.roomRepoDir,
      env: {
        PORT: String(roomPort),
        TABULA_ROOM_ALLOWED_ORIGINS: `${appOrigin},${peerOnlyAppOrigin}`,
        TABULA_ROOM_MAX_PAYLOAD_BYTES: String(4 * 1024 * 1024),
      },
      label: "tabula-room",
    });
    await waitForHttp(`${roomUrl}/health`, { label: "tabula-room /health" });

    firebaseServer = spawnLogged({
      command: "npm",
      args: ["run", "dev:firebase"],
      cwd: options.tabulaMdRepoDir,
      env: {},
      label: "firebase-emulators",
    });
    await waitForTcp(8080, { label: "Firestore emulator" });
    await waitForTcp(9199, { label: "Firebase Storage emulator" });

    appServer = spawnLogged({
      command: "npm",
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(appPort)],
      cwd: options.tabulaMdRepoDir,
      env: {
        VITE_TABULA_ROOM_URL: roomUrl,
        VITE_TABULA_JSON_URL: "http://127.0.0.1:9",
        VITE_TABULA_FIREBASE_CONFIG: firebaseConfig,
        VITE_TABULA_FIREBASE_EMULATOR_HOST: "127.0.0.1",
        VITE_TABULA_FIRESTORE_EMULATOR_PORT: "8080",
        VITE_TABULA_FIREBASE_STORAGE_EMULATOR_PORT: "9199",
      },
      label: "tabula-md",
    });
    await waitForHttp(appOrigin, { label: "tabula-md dev server" });

    peerOnlyAppServer = spawnLogged({
      command: "npm",
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(peerOnlyAppPort)],
      cwd: options.tabulaMdRepoDir,
      env: {
        VITE_TABULA_ROOM_URL: roomUrl,
        VITE_TABULA_JSON_URL: "http://127.0.0.1:9",
      },
      label: "tabula-md-peer-only",
    });
    await waitForHttp(peerOnlyAppOrigin, { label: "tabula-md peer-only dev server" });

    browser = await chromium.launch({ headless: !options.headed });
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageDiagnostics = [];
    page.on("console", (message) => pageDiagnostics.push(`[console:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => pageDiagnostics.push(`[pageerror] ${error.message}`));
    page.on("requestfailed", (request) =>
      pageDiagnostics.push(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`),
    );
    page.on("response", (response) => {
      if (response.status() >= 400) {
        pageDiagnostics.push(`[response:${response.status()}] ${response.request().method()} ${response.url()}`);
      }
    });

    await withMcpClient({ serverEntrypoint: options.serverEntrypoint, roomUrl, appOrigin, firebaseConfig }, async (client) => {
      const expectedTools = [
        "tabula_create_draft", "tabula_update_draft", "tabula_start_session", "tabula_join_room",
        "tabula_list_files", "tabula_read_file", "tabula_search_files", "tabula_write_file", "tabula_export_copy",
      ];
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), expectedTools);

      const draft = await callTool(client, "tabula_create_draft", {
        title: "README.md",
        content: "# MCP Local E2E\n\nInitial from MCP.\n",
      });
      const session = await callTool(client, "tabula_start_session", { draftId: draft.draftId });
      assert.match(session.sessionUrl, new RegExp(`^${appOrigin.replaceAll(".", "\\.")}/#room=`));
      assert.equal(session.ready, true);
      assert.equal(session.canWrite, true);

      await page.goto(session.sessionUrl);
      const browserInitialText = await waitForEditorText(page, "Initial from MCP.");
      const listed = await callTool(client, "tabula_list_files", { sessionId: session.sessionId });
      assert(listed.files.some((file) => file.path === "README.md"));
      const readme = await callTool(client, "tabula_read_file", { sessionId: session.sessionId, path: "README.md" });
      assert.equal(readme.content, "# MCP Local E2E\n\nInitial from MCP.\n");

      const nextContent = `${readme.content}\nEdited by tabula-mcp local E2E.\n`;
      await callTool(client, "tabula_write_file", {
        sessionId: session.sessionId,
        path: "README.md",
        content: nextContent,
        expectedRevision: readme.revision,
      });
      await callTool(client, "tabula_write_file", {
        sessionId: session.sessionId,
        path: "Agent Notes.md",
        content: "# Agent Notes\n\nCreated by MCP local E2E.\n",
      });

      const browserAfterMcpText = await waitForEditorText(page, "Edited by tabula-mcp local E2E.");
      const tabsAfterMcp = await tabTitles(page);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+f" : "Control+Alt+f");
      await page.locator(".right-file-tree").getByText("Agent Notes", { exact: false }).waitFor();

      await page.locator(".cm-content").click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
      await page.keyboard.type("\nHuman browser edit.\n");
      let afterHumanEdit;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        afterHumanEdit = await callTool(client, "tabula_read_file", { sessionId: session.sessionId, path: "README.md" });
        if (afterHumanEdit.content.includes("Human browser edit.")) break;
        await wait(250);
      }
      assert(afterHumanEdit?.content.includes("Human browser edit."), "MCP should observe browser-originated text");

      const peerDraft = await callTool(client, "tabula_create_draft", {
        title: "README.md",
        content: "# Peer-only recovery\n\nLoaded from the live MCP participant.\n",
      });
      const peerSession = await callTool(client, "tabula_start_session", { draftId: peerDraft.draftId });
      const peerOnlyPage = await context.newPage();
      await peerOnlyPage.goto(peerSession.sessionUrl.replace(appOrigin, peerOnlyAppOrigin));
      const peerOnlyBrowserText = await waitForEditorText(peerOnlyPage, "Loaded from the live MCP participant.");

      await withMcpClient({
        serverEntrypoint: options.serverEntrypoint,
        roomUrl,
        appOrigin: peerOnlyAppOrigin,
        firebaseConfig: null,
      }, async (peerClient) => {
        const joined = await callTool(peerClient, "tabula_join_room", { roomUrl: peerSession.sessionUrl });
        assert.equal(joined.ready, true);
        const peerRead = await callTool(peerClient, "tabula_read_file", { sessionId: joined.sessionId, path: "README.md" });
        assert.equal(peerRead.content, "# Peer-only recovery\n\nLoaded from the live MCP participant.\n");
      });
      await peerOnlyPage.close();

      console.log(JSON.stringify({
        ok: true,
        roomUrlShape: redactRoomUrl(session.sessionUrl),
        sessionId: session.sessionId,
        browserInitialText,
        browserAfterMcpText,
        afterHumanEditMarkdown: afterHumanEdit.content,
        tabsAfterMcp,
        peerOnlyBrowserText,
      }, null, 2));
    });
  } finally {
    await browser?.close();
    await stopProcess(peerOnlyAppServer);
    await stopProcess(appServer);
    await stopProcess(firebaseServer);
    await stopProcess(roomServer);
  }
};

await run();
