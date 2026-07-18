import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTabulaMcpServer } from "../dist/index.js";

const checkMode = process.argv.includes("--check");
const budgets = {
  oneTool: { target: 3_000, maximum: 4_000 },
  listTools: { target: 24_000, maximum: 32_000 },
};
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const reportBudget = (label, actual, budget) => {
  const status = actual > budget.maximum ? "over" : actual > budget.target ? "warn" : "ok";
  console.log(`${status} ${label}: ${actual} bytes, target ${budget.target}, maximum ${budget.maximum}`);
  if (checkMode && actual > budget.maximum) {
    throw new Error(`${label} exceeded context maximum: ${actual} > ${budget.maximum}`);
  }
};

const instance = createTabulaMcpServer({
  writeEnabled: true,
  env: {},
});
const client = new Client({ name: "tabula-context-measure", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await client.listTools();
  console.log(`core tools: ${tools.tools.length}`);
  for (const tool of tools.tools) {
    const bytes = jsonBytes(tool);
    console.log(`  ${tool.name.padEnd(28)} ${bytes} bytes`);
    reportBudget(`tool ${tool.name}`, bytes, budgets.oneTool);
  }
  reportBudget("core listTools", jsonBytes(tools), budgets.listTools);

} finally {
  await Promise.allSettled([client.close(), instance.server.close()]);
  await instance.registry.clear();
}
