import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:net";
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

const withMcpClient = async ({ serverEntrypoint, roomUrl }, callback) => {
  const client = new Client({ name: "tabula-mcp-local-e2e", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    cwd: rootDir,
    env: {
      ...process.env,
      TABULA_ROOM_URL: roomUrl,
      TABULA_MCP_ALLOW_ANY_EGRESS: "1",
    },
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
  const roomUrl = `http://127.0.0.1:${roomPort}`;
  const appOrigin = `http://127.0.0.1:${appPort}`;
  let roomServer;
  let appServer;
  let browser;

  try {
    roomServer = spawnLogged({
      command: "npm",
      args: ["run", "dev"],
      cwd: options.roomRepoDir,
      env: {
        PORT: String(roomPort),
        TABULA_ROOM_ALLOWED_ORIGINS: appOrigin,
        TABULA_ROOM_MAX_PAYLOAD_BYTES: String(4 * 1024 * 1024),
      },
      label: "tabula-room",
    });
    await waitForHttp(`${roomUrl}/health`, { label: "tabula-room /health" });

    appServer = spawnLogged({
      command: "npm",
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(appPort)],
      cwd: options.tabulaMdRepoDir,
      env: {
        VITE_TABULA_ROOM_URL: roomUrl,
        VITE_TABULA_JSON_URL: "http://127.0.0.1:9",
        VITE_TABULA_FIREBASE_CONFIG: "",
      },
      label: "tabula-md",
    });
    await waitForHttp(appOrigin, { label: "tabula-md dev server" });

    browser = await chromium.launch({ headless: !options.headed });
    const context = await browser.newContext();
    const page = await context.newPage();

    await withMcpClient({ serverEntrypoint: options.serverEntrypoint, roomUrl }, async (client) => {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      for (const toolName of [
        "tabula_create_workspace",
        "tabula_create_workspace_room",
        "tabula_read_workspace",
        "tabula_read_workspace_document",
        "tabula_apply_workspace_changes",
        "tabula_wait_for_changes",
      ]) {
        assert(toolNames.includes(toolName), `MCP local E2E requires ${toolName}`);
      }

      const created = await callTool(client, "tabula_create_workspace", {
        title: "MCP Local E2E",
        files: [
          {
            path: "README.md",
            markdown: "# MCP Local E2E\n\nInitial from MCP.\n",
          },
        ],
        detail: "tree",
      });
      const sourceDocument = created.documents.find((document) => document.title === "README.md");
      assert(sourceDocument, "created workspace should include README.md");

      const room = await callTool(client, "tabula_create_workspace_room", {
        workspaceId: created.workspaceId,
        appOrigin,
        roomServerUrl: roomUrl,
        identityName: "Local E2E Agent",
        identityColor: "#2563eb",
      });
      assert.match(room.roomUrl, new RegExp(`^${appOrigin.replaceAll(".", "\\.")}/#room=`));

      await page.goto(room.roomUrl);
      const browserInitialText = await waitForEditorText(page, "Initial from MCP.");
      assert(browserInitialText.includes("# MCP Local E2E"), "browser should receive MCP-created workspace text");

      const workspace = await callTool(client, "tabula_read_workspace", {
        sessionId: room.sessionId,
        detail: "tree",
      });
      const readme =
        workspace.documents.find((document) => document.id === sourceDocument.id) ??
        workspace.documents.find((document) => document.title === "README.md") ??
        workspace.documents.find((document) => document.title?.includes("README"));
      assert(
        readme,
        `room workspace should expose the MCP-created README document. Documents: ${JSON.stringify(workspace.documents)}`,
      );

      const readmeDocument = await callTool(client, "tabula_read_workspace_document", {
        sessionId: room.sessionId,
        documentId: readme.id,
      });
      assert.equal(readmeDocument.markdown, "# MCP Local E2E\n\nInitial from MCP.\n");

      const appended = "\nEdited by tabula-mcp local E2E.\n";
      const applied = await callTool(client, "tabula_apply_workspace_changes", {
        sessionId: room.sessionId,
        changes: [
          {
            type: "document.patch",
            documentId: readme.id,
            baseSha256: readmeDocument.sha256,
            patches: [
              {
                from: readmeDocument.markdown.length,
                to: readmeDocument.markdown.length,
                insert: appended,
              },
            ],
          },
          {
            type: "document.create",
            parentId: workspace.workspace.rootId,
            title: "Agent Notes.md",
            markdown: "# Agent Notes\n\nCreated by MCP local E2E.\n",
          },
        ],
      });
      assert.equal(applied.applied, true);
      assert.equal(applied.emittedTextUpdateCount, 2);
      assert.equal(applied.emittedWorkspaceUpdateCount, 1);

      const browserAfterMcpText = await waitForEditorText(page, "Edited by tabula-mcp local E2E.");
      assert(browserAfterMcpText.includes("Initial from MCP."), "MCP patch should preserve existing browser text");
      const tabsAfterMcp = await tabTitles(page);
      assert(
        tabsAfterMcp.some((tab) => tab.title.includes("Agent Notes.md")),
        `browser should show MCP-created Agent Notes.md tab. Tabs: ${JSON.stringify(tabsAfterMcp)}`,
      );

      const beforeHumanEdit = await callTool(client, "tabula_read_workspace_document", {
        sessionId: room.sessionId,
        documentId: readme.id,
      });

      await page.locator(".cm-content").click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
      await page.keyboard.type("\nHuman browser edit.\n");

      const waitResult = await callTool(client, "tabula_wait_for_changes", {
        sessionId: room.sessionId,
        sinceSha256: beforeHumanEdit.sha256,
        timeoutMs: 12_000,
      });
      assert.equal(waitResult.changed, true, "MCP should observe browser-originated document changes");
      assert(waitResult.changedDocumentIds.includes(readme.id), "changedDocumentIds should include edited README.md");

      const afterHumanEdit = await callTool(client, "tabula_read_workspace_document", {
        sessionId: room.sessionId,
        documentId: readme.id,
      });
      assert(afterHumanEdit.markdown.includes("Human browser edit."), "MCP should read browser-originated text");

      const disconnected = await callTool(client, "tabula_disconnect_room", {
        sessionId: room.sessionId,
      });
      assert.equal(disconnected.disconnectedSessionId, room.sessionId);

      const sessions = await callTool(client, "tabula_list_sessions");
      assert.deepEqual(sessions.sessions, []);

      console.log(
        JSON.stringify(
          {
            ok: true,
            roomUrlShape: redactRoomUrl(room.roomUrl),
            sessionId: room.sessionId,
            documentId: readme.id,
            browserInitialText,
            browserAfterMcpText,
            afterHumanEditMarkdown: afterHumanEdit.markdown,
            tabsAfterMcp,
          },
          null,
          2,
        ),
      );
    });
  } finally {
    await browser?.close();
    await stopProcess(appServer);
    await stopProcess(roomServer);
  }
};

await run();
