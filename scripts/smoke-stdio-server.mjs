import { strict as assert } from "node:assert";
import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultServerEntrypoint = path.join(rootDir, "dist", "index.js");
const documentAppResourceUri = "ui://tabula/document.html";

const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const collectRequestBody = async (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const createShareCaptureServer = async () => {
  const uploads = [];
  const server = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/v2/post/") {
      response.writeHead(404).end();
      return;
    }

    const snapshotId = `snapshot_${String(uploads.length + 1).padStart(3, "0")}`;
    uploads.push({
      method: request.method,
      url: request.url,
      body: await collectRequestBody(request),
    });
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: snapshotId,
        data: `http://${request.headers.host}/api/v2/${snapshotId}`,
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object", "share capture server must listen on a TCP port");

  return {
    uploads,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
};

const parseArgs = (argv) => {
  const parsed = {
    label: "MCP stdio server",
    serverCwd: rootDir,
    serverEntrypoint: defaultServerEntrypoint,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--server-entrypoint") {
      if (!next) {
        throw new Error("--server-entrypoint requires a value");
      }
      parsed.serverEntrypoint = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--server-cwd") {
      if (!next) {
        throw new Error("--server-cwd requires a value");
      }
      parsed.serverCwd = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--label") {
      if (!next) {
        throw new Error("--label requires a value");
      }
      parsed.label = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
};

const configuredServerEnv = ({ storeDir, jsonServerUrl }) => ({
  TABULA_MCP_DOCUMENT_STORE_DIR: storeDir,
  TABULA_JSON_URL: jsonServerUrl,
});

const zeroConfigServerEnv = (homeDir) => ({
  HOME: homeDir,
  LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
  XDG_STATE_HOME: path.join(homeDir, ".local", "state"),
});

const expectedZeroConfigStoreFile = (homeDir) => {
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Tabula.md MCP", "documents", "documents-v1.json");
  }

  if (process.platform === "win32") {
    return path.join(homeDir, "AppData", "Local", "Tabula.md MCP", "documents", "documents-v1.json");
  }

  return path.join(homeDir, ".local", "state", "tabula-mcp", "documents", "documents-v1.json");
};

const withStdioClient = async ({ mcpApps = false, serverCwd, serverEntrypoint, serverEnv }, callback) => {
  const client = new Client(
    { name: "tabula-mcp-stdio-smoke", version: "0.0.0" },
    mcpApps ? { capabilities: uiCapabilities } : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    cwd: serverCwd,
    env: serverEnv,
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
    assert(
      stderr.every((line) => line.includes("ExperimentalWarning: localStorage is not available")),
      `stdio server wrote unexpected stderr: ${stderr.join("")}`,
    );
  }
};

const toolNamesFrom = (tools) => tools.tools.map((tool) => tool.name);

const snapshotKeyFromShareUrl = (shareUrl) => {
  const url = new URL(shareUrl);
  const jsonValue = url.hash.replace(/^#json=/, "");
  const [, snapshotKey] = jsonValue.split(",");
  return snapshotKey || "";
};

const runNonAppClientSmoke = async ({ storeDir, jsonServerUrl, serverCwd, serverEntrypoint }) => {
  const serverEnv = configuredServerEnv({ storeDir, jsonServerUrl });
  await withStdioClient({ serverCwd, serverEntrypoint, serverEnv }, async (client) => {
    const tools = await client.listTools();
    const toolNames = toolNamesFrom(tools);
    assert(toolNames.includes("tabula_read_me"), "read_me should be available without MCP Apps");
    assert(!toolNames.includes("tabula_create_document"), "document App tools must require MCP Apps support");
    assert(!toolNames.includes("tabula_share_document"), "share App tool must require MCP Apps support");
    assert(toolNames.includes("tabula_propose_text_patches"), "default stdio server should allow proposal-first room edits");
    assert(toolNames.includes("tabula_read_workspace"), "default stdio server should expose workspace read tool");
    assert(toolNames.includes("tabula_read_workspace_document"), "default stdio server should expose workspace document read tool");
    assert(toolNames.includes("tabula_propose_workspace_changes"), "default stdio server should expose workspace proposal tool");
    assert(!toolNames.includes("tabula_apply_text_patches"), "default stdio server must not expose direct room writes");

    const readMe = await client.callTool({
      name: "tabula_read_me",
      arguments: { topic: "security" },
    });
    const text = readMe.content?.[0]?.type === "text" ? readMe.content[0].text : "";
    assert(text.includes("#room"), "security read_me should mention room key fragments");
  });
};

const runAppClientSmoke = async ({ storeDir, jsonServerUrl, uploads, serverCwd, serverEntrypoint }) => {
  const serverEnv = configuredServerEnv({ storeDir, jsonServerUrl });
  return withStdioClient({ mcpApps: true, serverCwd, serverEntrypoint, serverEnv }, async (client) => {
    const tools = await client.listTools();
    const toolNames = toolNamesFrom(tools);
    for (const toolName of [
      "tabula_create_document",
      "tabula_list_documents",
      "tabula_open_document",
      "tabula_share_document",
    ]) {
      assert(toolNames.includes(toolName), `MCP Apps stdio client should expose ${toolName}`);
    }
    assert(toolNames.includes("tabula_propose_text_patches"), "MCPB-compatible stdio smoke should expose proposal tool");
    assert(toolNames.includes("tabula_read_workspace"), "MCPB-compatible stdio smoke should expose workspace read tool");
    assert(toolNames.includes("tabula_read_workspace_document"), "MCPB-compatible stdio smoke should expose workspace document read tool");
    assert(toolNames.includes("tabula_propose_workspace_changes"), "MCPB-compatible stdio smoke should expose workspace proposal tool");
    assert(!toolNames.includes("tabula_apply_text_patches"), "MCPB-compatible stdio smoke should not expose direct writes");

    const resource = await client.readResource({ uri: documentAppResourceUri });
    const appHtml = resource.contents?.[0]?.text || "";
    assert(resource.contents?.[0]?.mimeType === "text/html;profile=mcp-app", "Document App resource must be MCP App HTML");
    assert(appHtml.includes("Tabula.md Document"), "Document App resource should contain the bundled App HTML");
    assert(!appHtml.includes("dev-only-not-a-real-key"), "Document App resource must not contain dev share fixture data");

    const plaintext = "# Stdio Smoke\n\nPlaintext should stay local.";
    const createResult = await client.callTool({
      name: "tabula_create_document",
      arguments: {
        title: "Stdio Smoke",
        markdown: plaintext,
      },
    });
    const documentId = createResult.structuredContent?.document?.documentId;
    assert.equal(createResult.structuredContent?.document?.title, "Stdio Smoke");
    assert.match(documentId || "", /^[0-9a-f-]{36}$/i);

    const updatedMarkdown = "# Stdio Smoke\n\nUpdated local checkpoint.";
    const saveResult = await client.callTool({
      name: "tabula_app_save_document",
      arguments: {
        documentId,
        title: "Stdio Smoke Saved",
        markdown: updatedMarkdown,
      },
    });
    assert.equal(saveResult.structuredContent?.markdown, updatedMarkdown);

    const listResult = await client.callTool({ name: "tabula_list_documents", arguments: {} });
    assert.equal(listResult.structuredContent?.documents?.[0]?.documentId, documentId);
    assert.equal(listResult.structuredContent?.documents?.[0]?.title, "Stdio Smoke Saved");

    const openResult = await client.callTool({
      name: "tabula_open_document",
      arguments: { documentId },
    });
    assert.equal(openResult.structuredContent?.markdown, updatedMarkdown);

    const shareResult = await client.callTool({
      name: "tabula_share_document",
      arguments: {
        documentId,
        appOrigin: "http://127.0.0.1:5173",
      },
    });
    const share = shareResult.structuredContent?.share;
    assert.equal(share?.encrypted, true);
    assert.equal(share?.jsonServerUrl, jsonServerUrl);
    assert.match(share?.shareUrl || "", /^http:\/\/127\.0\.0\.1:5173\/#json=[^,]+,/);

    assert.equal(uploads.length, 1, "share flow should upload exactly one encrypted snapshot");
    assert.equal(uploads[0].url, "/api/v2/post/");
    const uploadText = uploads[0].body.toString("utf8");
    assert(!uploadText.includes("Updated local checkpoint"), "share upload must not include plaintext Markdown");
    assert(!uploadText.includes(snapshotKeyFromShareUrl(share.shareUrl)), "share upload must not include the snapshot key");

    return {
      documentId,
      updatedMarkdown,
      title: "Stdio Smoke Saved",
    };
  });
};

const runRestartPersistenceSmoke = async ({
  storeDir,
  jsonServerUrl,
  documentId,
  title,
  updatedMarkdown,
  serverCwd,
  serverEntrypoint,
}) => {
  const serverEnv = configuredServerEnv({ storeDir, jsonServerUrl });
  await withStdioClient({ mcpApps: true, serverCwd, serverEntrypoint, serverEnv }, async (client) => {
    const listResult = await client.callTool({ name: "tabula_list_documents", arguments: {} });
    const restored = listResult.structuredContent?.documents?.find((document) => document.documentId === documentId);
    assert(restored, "restarted stdio server should list the saved local checkpoint");
    assert.equal(restored.title, title);
    assert.equal(restored.textLength, updatedMarkdown.length);

    const openResult = await client.callTool({
      name: "tabula_open_document",
      arguments: { documentId },
    });
    assert.equal(openResult.structuredContent?.document?.documentId, documentId);
    assert.equal(openResult.structuredContent?.document?.title, title);
    assert.equal(openResult.structuredContent?.markdown, updatedMarkdown);
  });
};

const runZeroConfigSmoke = async ({ jsonServerUrl, uploads, serverCwd, serverEntrypoint }) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "tabula-mcp-zero-home-"));
  const serverEnv = zeroConfigServerEnv(homeDir);
  const updatedMarkdown = "# Zero Config Smoke\n\nSaved without Tabula installer env.";
  let documentId = "";

  try {
    await withStdioClient({ mcpApps: true, serverCwd, serverEntrypoint, serverEnv }, async (client) => {
      const tools = await client.listTools();
      const toolNames = toolNamesFrom(tools);
      assert(toolNames.includes("tabula_create_document"), "zero-config MCP Apps client should expose document tools");
      assert(toolNames.includes("tabula_share_document"), "zero-config MCP Apps client should expose share tool");
      assert(toolNames.includes("tabula_propose_text_patches"), "zero-config MCPB smoke should expose proposal tool");
      assert(toolNames.includes("tabula_read_workspace"), "zero-config MCPB smoke should expose workspace read tool");
      assert(toolNames.includes("tabula_read_workspace_document"), "zero-config MCPB smoke should expose workspace document read tool");
      assert(toolNames.includes("tabula_propose_workspace_changes"), "zero-config MCPB smoke should expose workspace proposal tool");
      assert(!toolNames.includes("tabula_apply_text_patches"), "zero-config MCPB smoke should not expose direct writes");

      const createResult = await client.callTool({
        name: "tabula_create_document",
        arguments: {
          title: "Zero Config Smoke",
          markdown: "# Zero Config Smoke\n\nDraft created with no Tabula installer env.",
        },
      });
      documentId = createResult.structuredContent?.document?.documentId;
      assert.match(documentId || "", /^[0-9a-f-]{36}$/i);

      const saveResult = await client.callTool({
        name: "tabula_app_save_document",
        arguments: {
          documentId,
          title: "Zero Config Smoke Saved",
          markdown: updatedMarkdown,
        },
      });
      assert.equal(saveResult.structuredContent?.markdown, updatedMarkdown);
      assert(
        existsSync(expectedZeroConfigStoreFile(homeDir)),
        "zero-config server should create the default local checkpoint file",
      );

      const uploadCountBeforeShare = uploads.length;
      const shareResult = await client.callTool({
        name: "tabula_share_document",
        arguments: {
          documentId,
          appOrigin: "http://127.0.0.1:5173",
          jsonServerUrl,
        },
      });
      const share = shareResult.structuredContent?.share;
      assert.equal(share?.jsonServerUrl, jsonServerUrl);
      assert.match(share?.shareUrl || "", /^http:\/\/127\.0\.0\.1:5173\/#json=[^,]+,/);
      assert.equal(uploads.length, uploadCountBeforeShare + 1, "zero-config share should upload one encrypted snapshot");
      const uploadText = uploads.at(-1)?.body.toString("utf8") ?? "";
      assert(!uploadText.includes("Saved without Tabula installer env"), "zero-config share upload must not include plaintext");
      assert(!uploadText.includes(snapshotKeyFromShareUrl(share.shareUrl)), "zero-config share upload must not include the snapshot key");
    });

    await withStdioClient({ mcpApps: true, serverCwd, serverEntrypoint, serverEnv }, async (client) => {
      const listResult = await client.callTool({ name: "tabula_list_documents", arguments: {} });
      const restored = listResult.structuredContent?.documents?.find((document) => document.documentId === documentId);
      assert(restored, "zero-config restarted server should list the default checkpoint");
      assert.equal(restored.title, "Zero Config Smoke Saved");

      const openResult = await client.callTool({
        name: "tabula_open_document",
        arguments: { documentId },
      });
      assert.equal(openResult.structuredContent?.markdown, updatedMarkdown);
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const storeDir = await mkdtemp(path.join(tmpdir(), "tabula-mcp-stdio-"));
  const shareServer = await createShareCaptureServer();
  const runtime = {
    serverCwd: options.serverCwd,
    serverEntrypoint: options.serverEntrypoint,
  };

  try {
    await runNonAppClientSmoke({ storeDir, jsonServerUrl: shareServer.url, ...runtime });
    const checkpoint = await runAppClientSmoke({
      storeDir,
      jsonServerUrl: shareServer.url,
      uploads: shareServer.uploads,
      ...runtime,
    });
    await runRestartPersistenceSmoke({
      storeDir,
      jsonServerUrl: shareServer.url,
      ...runtime,
      ...checkpoint,
    });
    await runZeroConfigSmoke({
      jsonServerUrl: shareServer.url,
      uploads: shareServer.uploads,
      ...runtime,
    });
  } finally {
    await shareServer.close();
    await rm(storeDir, { recursive: true, force: true });
  }

  console.log(`${options.label} smoke passed`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
