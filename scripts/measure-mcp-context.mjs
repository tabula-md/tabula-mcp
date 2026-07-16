import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTabulaMcpServer } from "../dist/index.js";
import { MemoryDocumentStore } from "../dist/documents/store.js";

const checkMode = process.argv.includes("--check");
const budgets = {
  listToolsBytes: 14_000,
  draftResultBytes: 1_000,
  updateResultBytes: 1_000,
};
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const assertBudget = (label, actual, budget) => {
  const ok = actual <= budget;
  console.log(`${ok ? "ok" : "over"} ${label}: ${actual} bytes, budget ${budget}`);
  if (checkMode && !ok) throw new Error(`${label} exceeded context budget: ${actual} > ${budget}`);
};

const instance = createTabulaMcpServer({
  writeEnabled: true,
  documentStore: new MemoryDocumentStore(),
  env: {},
});
const client = new Client({ name: "tabula-context-measure", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await client.listTools();
  console.log(`core tools: ${tools.tools.length}`);
  for (const tool of tools.tools) console.log(`  ${tool.name.padEnd(28)} ${jsonBytes(tool)} bytes`);
  assertBudget("core listTools", jsonBytes(tools), budgets.listToolsBytes);

  const created = await client.callTool({
    name: "tabula_create_draft",
    arguments: { title: "Context", content: "# Context\n" },
  });
  assertBudget("create_draft result", jsonBytes(created), budgets.draftResultBytes);
  const draft = created.structuredContent;
  const updated = await client.callTool({
    name: "tabula_update_draft",
    arguments: {
      draftId: draft.draftId,
      content: "# Context\n\nUpdated\n",
      expectedRevision: draft.revision,
    },
  });
  assertBudget("update_draft result", jsonBytes(updated), budgets.updateResultBytes);
} finally {
  await Promise.allSettled([client.close(), instance.server.close()]);
  instance.registry.clear();
  instance.workspaces.clear();
  await instance.documents.clear();
}
