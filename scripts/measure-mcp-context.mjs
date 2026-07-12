import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTabulaMcpServer } from "../dist/index.js";
import { MemoryDocumentStore } from "../dist/documents/store.js";

const checkMode = process.argv.includes("--check");

const budgets = {
  toolOnlyListToolsBytes: 24_000,
  mcpAppListToolsBytes: 32_000,
  createWorkspaceResultBytes: 16_000,
  workspaceContextResultBytes: 12_000,
  documentReadResultBytes: 4_000,
};

const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const approxTokens = (bytes) => Math.ceil(bytes / 4);

const assertBudget = (label, actual, budget) => {
  const ok = actual <= budget;
  console.log(`${ok ? "ok" : "over"} ${label}: ${actual} bytes (~${approxTokens(actual)} tokens), budget ${budget}`);
  if (checkMode && !ok) {
    throw new Error(`${label} exceeded context budget: ${actual} > ${budget}`);
  }
};

const withClient = async ({ mcpApps = false } = {}, callback) => {
  const { server, registry, workspaces, documents } = createTabulaMcpServer({
    writeEnabled: false,
    documentStore: new MemoryDocumentStore(),
    forceDocumentAppTools: mcpApps,
  });
  const client = new Client(
    { name: "tabula-mcp-context-measure", version: "0.0.0" },
    mcpApps ? { capabilities: uiCapabilities } : undefined,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await callback(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    registry.clear();
    workspaces.clear();
    documents.clear();
  }
};

const measureTools = async ({ mcpApps }) =>
  withClient({ mcpApps }, async (client) => {
    const tools = await client.listTools();
    const bytes = jsonBytes(tools);
    console.log("");
    console.log(`${mcpApps ? "MCP App-capable" : "tool-only"} tools: ${tools.tools.length}`);
    for (const tool of tools.tools) {
      const toolBytes = jsonBytes(tool);
      console.log(`  ${tool.name.padEnd(36)} ${String(toolBytes).padStart(5)} bytes ~${approxTokens(toolBytes)} tokens`);
    }
    return bytes;
  });

const measureWorkspaceResults = async () =>
  withClient({}, async (client) => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      path: `docs/file-${String(index + 1).padStart(2, "0")}.md`,
      markdown: `# File ${index + 1}\n\n${"A".repeat(2_000)}\n`,
    }));
    const createArguments = { title: "Twenty Files", files };
    const createResult = await client.callTool({
      name: "tabula_create_workspace",
      arguments: createArguments,
    });
    const workspaceId = createResult.structuredContent?.workspaceId;
    const firstDocumentId = createResult.structuredContent?.documents?.[0]?.id;
    if (typeof workspaceId !== "string" || typeof firstDocumentId !== "string") {
      throw new Error("workspace measurement did not receive workspaceId/documentId");
    }

    const contextResult = await client.callTool({
      name: "tabula_read_workspace_context",
      arguments: { workspaceId },
    });
    const documentResult = await client.callTool({
      name: "tabula_read_workspace_document",
      arguments: { workspaceId, documentId: firstDocumentId },
    });

    return {
      createArgumentsBytes: jsonBytes(createArguments),
      createResultBytes: jsonBytes(createResult),
      contextResultBytes: jsonBytes(contextResult),
      documentResultBytes: jsonBytes(documentResult),
    };
  });

const main = async () => {
  const toolOnlyBytes = await measureTools({ mcpApps: false });
  const mcpAppBytes = await measureTools({ mcpApps: true });
  console.log("");
  assertBudget("tool-only listTools", toolOnlyBytes, budgets.toolOnlyListToolsBytes);
  assertBudget("MCP App listTools", mcpAppBytes, budgets.mcpAppListToolsBytes);

  const workspace = await measureWorkspaceResults();
  console.log("");
  console.log(`inline 20-file create arguments: ${workspace.createArgumentsBytes} bytes (~${approxTokens(workspace.createArgumentsBytes)} tokens)`);
  assertBudget("20-file create_workspace result", workspace.createResultBytes, budgets.createWorkspaceResultBytes);
  assertBudget("20-file read_workspace_context default result", workspace.contextResultBytes, budgets.workspaceContextResultBytes);
  assertBudget("2KB read_workspace_document result", workspace.documentResultBytes, budgets.documentReadResultBytes);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
