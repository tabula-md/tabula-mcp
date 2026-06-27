import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(rootDir, "dist", "mcpb", "tabula-mcp");

const requiredFiles = [
  "manifest.json",
  "server/index.js",
  "server/document-app.html",
  "server/app/tools.js",
  "server/app/resource.js",
  "server/documents/registry.js",
  "server/share.js",
  "server/guidance.js",
  "README.md",
  "LICENSE",
];

const requiredTools = [
  "tabula_read_me",
  "tabula_create_document",
  "tabula_share_document",
  "tabula_connect_room",
  "tabula_read_markdown",
  "tabula_get_outline",
  "tabula_room_status",
  "tabula_open_room_view",
];

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(bundleDir, relativePath), "utf8"));

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const main = async () => {
  for (const relativePath of requiredFiles) {
    assert(existsSync(path.join(bundleDir, relativePath)), `MCPB staged bundle is missing ${relativePath}`);
  }

  const manifest = await readJson("manifest.json");
  assert(!("user_config" in manifest), "MCPB manifest must not include installer user_config");
  assert(manifest.server?.mcp_config?.command === "node", "MCPB server command must be node");
  assert(
    manifest.server?.mcp_config?.args?.includes("${__dirname}/server/index.js"),
    "MCPB server args must point to bundled server/index.js",
  );

  const toolNames = new Set(manifest.tools?.map((tool) => tool.name));
  for (const toolName of requiredTools) {
    assert(toolNames.has(toolName), `MCPB manifest is missing tool ${toolName}`);
  }

  const appHtml = await readFile(path.join(bundleDir, "server", "document-app.html"), "utf8");
  for (const expected of ["titleInput", "markdownPreview", "data-view-mode", "shareDocumentButton"]) {
    assert(appHtml.includes(expected), `bundled Document App is missing ${expected}`);
  }
  assert(!appHtml.includes("dev-only-not-a-real-key"), "bundled Document App includes dev-only fixture data");
  assert(!appHtml.includes("/src/app-dev/"), "bundled Document App includes dev harness source paths");

  console.log("MCPB bundle check passed");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
