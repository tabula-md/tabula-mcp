import { strict as assert } from "node:assert";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreTools = [
  "tabula_start_session",
  "tabula_join_room",
  "tabula_list_files",
  "tabula_read_files",
  "tabula_search_files",
  "tabula_write_file",
  "tabula_write_files",
  "tabula_export_copy",
];
const uiCapabilities = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};

const parseArgs = (argv) => {
  const result = { label: "MCP stdio server", serverCwd: rootDir, serverEntrypoint: path.join(rootDir, "dist", "index.js") };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--server-entrypoint" && value) result.serverEntrypoint = path.resolve(value);
    else if (argv[index] === "--server-cwd" && value) result.serverCwd = path.resolve(value);
    else if (argv[index] === "--label" && value) result.label = value;
    else throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    index += 1;
  }
  return result;
};

const createShareServer = async () => {
  const uploads = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const id = `snapshot_${uploads.length + 1}`;
      uploads.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id, data: `http://${request.headers.host}/api/v2/${id}` }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    uploads,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const withClient = async ({ options, env, mcpApps }, callback) => {
  const client = new Client(
    { name: "tabula-stdio-smoke", version: "0.0.0" },
    mcpApps ? { capabilities: uiCapabilities } : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverEntrypoint],
    cwd: options.serverCwd,
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
    assert(stderr.every((line) => line.includes("ExperimentalWarning: localStorage is not available")), stderr.join(""));
  }
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  const storeDir = await mkdtemp(path.join(tmpdir(), "tabula-mcp-stdio-"));
  const shareServer = await createShareServer();
  const env = {
    TABULA_MCP_DOCUMENT_STORE_DIR: storeDir,
    TABULA_JSON_URL: shareServer.url,
    TABULA_MCP_ALLOWED_JSON_SERVER_URLS: shareServer.url,
  };
  try {
    await withClient({ options, env, mcpApps: false }, async (client) => {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), coreTools);
      assert(tools.tools.every((tool) => tool.outputSchema), "every core tool should declare outputSchema");
      assert(client.getInstructions()?.includes("Export Copy"));

      const exported = await client.callTool({
        name: "tabula_export_copy",
        arguments: {
          source: {
            kind: "files",
            title: "Stdio Smoke",
            files: [{ path: "stdio-smoke.md", content: "# Stdio Smoke\n\nHost-native plaintext.\n" }],
          },
        },
      });
      assert.match(exported.structuredContent?.copyUrl || "", /^https:\/\/tabula\.md\/#json=[^,]+,/);
      assert.equal(exported.structuredContent?.fileCount, 1);
      const upload = shareServer.uploads.at(-1)?.toString("utf8") ?? "";
      assert(!upload.includes("Host-native plaintext"));
      assert(!upload.includes((exported.structuredContent?.copyUrl || "").split(",")[1] || "missing-key"));
    });

    await withClient({ options, env, mcpApps: true }, async (client) => {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), coreTools);
      const resources = await client.listResources();
      const uri = resources.resources.find((resource) => resource.uri.startsWith("ui://tabula/document-"))?.uri;
      assert(uri, "Tabula Handoff MCP App resource should be present");
      const resource = await client.readResource({ uri });
      assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
      assert(
        resources.resources.every((candidate) => !candidate.uri.startsWith("tabula://draft/")),
        "resources/list must not expose removed draft resources",
      );
      assert(
        resources.resources.every((candidate) => !candidate.uri.startsWith("tabula://workspace/")),
        "legacy workspace resources must not be exposed",
      );
    });
  } finally {
    await shareServer.close();
    await rm(storeDir, { recursive: true, force: true });
  }
  console.log(`${options.label} smoke passed`);
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
