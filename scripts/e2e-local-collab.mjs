import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoomRepoDir = path.resolve(rootDir, "../tabula-room");
const defaultTabulaMdRepoDir = path.resolve(rootDir, "../marker 2");
const defaultJsonRepoDir = path.resolve(rootDir, "../tabula-json");
const defaultServerEntrypoint = path.join(rootDir, "dist", "index.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv) => {
  const parsed = {
    roomRepoDir: process.env.TABULA_ROOM_REPO_DIR || defaultRoomRepoDir,
    tabulaMdRepoDir: process.env.TABULA_MD_REPO_DIR || defaultTabulaMdRepoDir,
    jsonRepoDir: process.env.TABULA_JSON_REPO_DIR || defaultJsonRepoDir,
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
    if (arg === "--json-repo-dir") {
      if (!next) {
        throw new Error("--json-repo-dir requires a value");
      }
      parsed.jsonRepoDir = path.resolve(next);
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

const withMcpClient = async ({ serverEntrypoint, roomUrl, appOrigin, jsonUrl, firebaseConfig }, callback) => {
  const client = new Client({ name: "tabula-mcp-local-e2e", version: "0.0.0" });
  const env = {
    ...process.env,
    TABULA_ROOM_URL: roomUrl,
    TABULA_APP_ORIGIN: appOrigin,
    TABULA_JSON_URL: jsonUrl,
    TABULA_MCP_ALLOWED_JSON_SERVER_URLS: jsonUrl,
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

const openJsonCopy = async ({ browser, copyUrl, expectedText, expectedFileTitle }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const parsedCopyUrl = new URL(copyUrl);
  const requestUrls = [];
  const responses = [];
  const diagnostics = [];
  page.on("request", (request) => requestUrls.push(request.url()));
  page.on("response", (response) => {
    if (response.status() >= 400 || response.url().includes("/api/v2/")) {
      responses.push({ status: response.status(), url: response.url() });
    }
  });
  page.on("console", (message) => diagnostics.push(`[console:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`[pageerror] ${error.message}`));
  await page.goto(parsedCopyUrl.origin);
  await page.getByRole("button", { name: "New document", exact: true }).click();
  await page.locator(".cm-content").waitFor();
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, parsedCopyUrl.hash);
  const modal = page.locator(".share-modal");
  const deadline = Date.now() + 20_000;
  let autoOpened = false;
  let confirmationReady = false;
  while (Date.now() < deadline) {
    const [editorText, readyCount, modalText] = await Promise.all([
      pageEditorText(page).catch(() => ""),
      modal.locator(".json-import-copy").count(),
      modal.textContent().catch(() => ""),
    ]);
    if (editorText.includes(expectedText)) {
      autoOpened = true;
      break;
    }
    if (readyCount > 0) {
      confirmationReady = true;
      break;
    }
    if (modalText.includes("Unable to open link")) break;
    await page.waitForTimeout(100);
  }
  if (!autoOpened && !confirmationReady) {
    const modalText = await modal.textContent().catch(() => "");
    throw new Error(
      `Export Copy did not become ready.\n${JSON.stringify({ modalText, responses, diagnostics }, null, 2)}`,
    );
  }
  if (confirmationReady) {
    await modal.locator("button.share-modal-primary").click();
    await modal.waitFor({ state: "detached" });
  }
  if (expectedFileTitle) {
    const expectedTab = page.locator(`.tab-item[data-file-name=${JSON.stringify(expectedFileTitle)}]`).first();
    await expectedTab.waitFor();
    await expectedTab.click();
  }
  const markdown = await waitForEditorText(page, expectedText);
  const [, copyKey = ""] = parsedCopyUrl.hash.replace(/^#json=/, "").split(",");
  assert(copyKey, "Export Copy should include a client-only decryption key");
  assert(
    requestUrls.every((url) => !url.includes(copyKey)),
    "Opening Export Copy must not send the decryption key in a network request",
  );
  return { context, page, markdown };
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  const roomPort = await getFreePort();
  const jsonPort = await getFreePort();
  const appPort = await getFreePort();
  const peerOnlyAppPort = await getFreePort();
  const roomUrl = `http://127.0.0.1:${roomPort}`;
  const jsonUrl = `http://127.0.0.1:${jsonPort}`;
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const peerOnlyAppOrigin = `http://127.0.0.1:${peerOnlyAppPort}`;
  let roomServer;
  let jsonServer;
  let appServer;
  let peerOnlyAppServer;
  let firebaseServer;
  let browser;
  const jsonDataDir = await mkdtemp(path.join(tmpdir(), "tabula-mcp-json-e2e-"));
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

    jsonServer = spawnLogged({
      command: "npm",
      args: ["run", "dev"],
      cwd: options.jsonRepoDir,
      env: {
        PORT: String(jsonPort),
        TABULA_JSON_ALLOWED_ORIGINS: appOrigin,
        TABULA_JSON_STORAGE_DRIVER: "file",
        TABULA_JSON_DATA_DIR: jsonDataDir,
      },
      label: "tabula-json",
    });
    await waitForHttp(`${jsonUrl}/health`, { label: "tabula-json /health" });

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
        VITE_TABULA_JSON_URL: jsonUrl,
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

    await withMcpClient({ serverEntrypoint: options.serverEntrypoint, roomUrl, appOrigin, jsonUrl, firebaseConfig }, async (client) => {
      const expectedTools = [
        "start_session", "join_room", "list_files", "read_file", "read_multiple_files",
        "search_files", "write_file", "write_files", "edit_file", "create_directory",
        "move_file", "delete_path", "import_copy", "export_copy",
      ];
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), expectedTools);

      const inlineCopy = await callTool(client, "export_copy", {
        title: "Research handoff",
        files: [
          { path: "brief.md", content: "# Brief\n\nThree-file browser handoff.\n" },
          { path: "research/notes.md", content: "# Notes\n\nNested Markdown file.\n" },
          { path: "decision.md", content: "# Decision\n\nReady for review.\n" },
        ],
      });
      assert.equal(inlineCopy.fileCount, 3);
      const importedInlineCopy = await callTool(client, "import_copy", {
        copyUrl: inlineCopy.copyUrl,
      });
      assert.equal(importedInlineCopy.title, "Research handoff");
      assert.deepEqual(importedInlineCopy.files, [
        { path: "brief.md", content: "# Brief\n\nThree-file browser handoff.\n" },
        { path: "decision.md", content: "# Decision\n\nReady for review.\n" },
        { path: "research/notes.md", content: "# Notes\n\nNested Markdown file.\n" },
      ]);
      const openedInlineCopy = await openJsonCopy({
        browser,
        copyUrl: inlineCopy.copyUrl,
        expectedText: "Three-file browser handoff.",
        expectedFileTitle: "brief.md",
      });
      const inlineCopyTabs = await tabTitles(openedInlineCopy.page);
      assert.equal(inlineCopyTabs.length, 3, "Inline Export Copy should open all three Markdown files");
      assert(
        inlineCopyTabs.some((tab) => tab.title === "notes.md"),
        "Inline Export Copy should preserve the nested Markdown file",
      );
      await openedInlineCopy.context.close();

      const session = await callTool(client, "start_session", {
        title: "MCP Local E2E",
        files: [{ path: "README.md", content: "# MCP Local E2E\n\nInitial from MCP.\n" }],
      });
      assert.match(session.sessionUrl, new RegExp(`^${appOrigin.replaceAll(".", "\\.")}/#room=`));
      assert.equal(session.ready, true);
      assert.equal(session.canWrite, true);

      await page.goto(session.sessionUrl);
      const browserInitialText = await waitForEditorText(page, "Initial from MCP.");
      const listed = await callTool(client, "list_files", { sessionId: session.sessionId });
      assert(listed.files.some((file) => file.path === "README.md"));
      const readmeBatch = await callTool(client, "read_multiple_files", {
        sessionId: session.sessionId,
        paths: ["README.md"],
      });
      const readme = readmeBatch.files[0];
      assert.equal(readme.content, "# MCP Local E2E\n\nInitial from MCP.\n");

      const nextContent = `${readme.content}\nEdited by tabula-mcp local E2E.\n`;
      await callTool(client, "write_files", {
        sessionId: session.sessionId,
        files: [{ path: "README.md", content: nextContent, expectedRevision: readme.revision }],
      });
      const batchWrite = await callTool(client, "write_files", {
        sessionId: session.sessionId,
        files: [
          { path: "Agent Notes.md", content: "# Agent Notes\n\nCreated by MCP local E2E.\n" },
          { path: "research/sources.md", content: "# Sources\n\nImported as a nested local file.\n" },
        ],
      });
      assert.deepEqual({ createdCount: batchWrite.createdCount, changedCount: batchWrite.changedCount }, { createdCount: 2, changedCount: 2 });

      const browserAfterMcpText = await waitForEditorText(page, "Edited by tabula-mcp local E2E.");
      const tabsAfterMcp = await tabTitles(page);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+f" : "Control+Alt+f");
      await page.locator(".right-file-tree").getByText("Agent Notes", { exact: false }).waitFor();
      await page.locator(".right-file-tree").getByText("research", { exact: false }).waitFor();

      await page.locator(".cm-content").click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
      await page.keyboard.type("\nHuman browser edit.\n");
      let afterHumanEdit;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const readBatch = await callTool(client, "read_multiple_files", {
          sessionId: session.sessionId,
          paths: ["README.md"],
        });
        afterHumanEdit = readBatch.files[0];
        if (afterHumanEdit.content.includes("Human browser edit.")) break;
        await wait(250);
      }
      assert(afterHumanEdit?.content.includes("Human browser edit."), "MCP should observe browser-originated text");

      const sessionCopy = await callTool(client, "export_copy", {
        sessionId: session.sessionId,
      });
      assert.equal(sessionCopy.fileCount, 3);
      const openedSessionCopy = await openJsonCopy({
        browser,
        copyUrl: sessionCopy.copyUrl,
        expectedText: "Human browser edit.",
        expectedFileTitle: "README.md",
      });
      const copyTabs = await tabTitles(openedSessionCopy.page);
      assert(copyTabs.some((tab) => tab.title === "Agent Notes.md"), "Session Copy should preserve all exported files");
      assert(copyTabs.some((tab) => tab.title === "sources.md"), "Session Copy should preserve nested batch files");

      const postExportContent = `${afterHumanEdit.content}\nChanged after Export Copy.\n`;
      await callTool(client, "write_files", {
        sessionId: session.sessionId,
        files: [{ path: "README.md", content: postExportContent, expectedRevision: afterHumanEdit.revision }],
      });
      await waitForEditorText(page, "Changed after Export Copy.");
      await openedSessionCopy.page.waitForTimeout(500);
      assert(
        !(await pageEditorText(openedSessionCopy.page)).includes("Changed after Export Copy."),
        "Export Copy must not follow later live Session changes",
      );
      await openedSessionCopy.page.reload();
      await waitForEditorText(openedSessionCopy.page, "Human browser edit.");
      assert(
        !(await pageEditorText(openedSessionCopy.page)).includes("Changed after Export Copy."),
        "Reloaded Export Copy must remain immutable",
      );
      await openedSessionCopy.context.close();

      const peerSession = await callTool(client, "start_session", {
        title: "README.md",
        files: [{ path: "README.md", content: "# Peer-only recovery\n\nLoaded from the live MCP participant.\n" }],
      });
      const peerOnlyPage = await context.newPage();
      await peerOnlyPage.goto(peerSession.sessionUrl.replace(appOrigin, peerOnlyAppOrigin));
      const peerOnlyBrowserText = await waitForEditorText(peerOnlyPage, "Loaded from the live MCP participant.");

      await withMcpClient({
        serverEntrypoint: options.serverEntrypoint,
        roomUrl,
        appOrigin: peerOnlyAppOrigin,
        jsonUrl,
        firebaseConfig: null,
      }, async (peerClient) => {
        const joined = await callTool(peerClient, "join_room", { roomUrl: peerSession.sessionUrl });
        assert.equal(joined.ready, true);
        const peerReadBatch = await callTool(peerClient, "read_multiple_files", {
          sessionId: joined.sessionId,
          paths: ["README.md"],
        });
        const peerRead = peerReadBatch.files[0];
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
        inlineCopyOpened: true,
        inlineCopyImportedByAgent: true,
        sessionCopyImmutable: true,
        peerOnlyBrowserText,
      }, null, 2));
    });
  } finally {
    await browser?.close();
    await stopProcess(peerOnlyAppServer);
    await stopProcess(appServer);
    await stopProcess(firebaseServer);
    await stopProcess(jsonServer);
    await stopProcess(roomServer);
    await rm(jsonDataDir, { recursive: true, force: true });
  }
};

await run();
