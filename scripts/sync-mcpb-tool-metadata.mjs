import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(rootDir, "mcpb", "manifest.json");
const metadataModuleUrl = pathToFileURL(path.join(rootDir, "dist", "server", "tool-metadata.js")).href;
const writeMode = process.argv.includes("--write");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { CORE_TOOL_METADATA, CORE_TOOL_NAMES } = await import(metadataModuleUrl);
const expectedTools = CORE_TOOL_NAMES.map((name) => ({
  name,
  description: CORE_TOOL_METADATA[name].description,
}));

if (writeMode) {
  manifest.tools = expectedTools;
  manifest.tools_generated = true;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated ${path.relative(rootDir, manifestPath)} from runtime tool metadata`);
} else if (JSON.stringify(manifest.tools) !== JSON.stringify(expectedTools)) {
  throw new Error("mcpb/manifest.json tool metadata is stale; run npm run sync:mcpb-tools");
} else {
  console.log("MCPB manifest tool metadata matches the runtime source");
}
