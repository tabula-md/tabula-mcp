import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const versionedName = `tabula-mcp-${packageJson.version}.mcpb`;
const stableName = "tabula-mcp.mcpb";

const sha256 = async (filePath) => {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
};

const versionedHash = await sha256(path.join(distDir, versionedName));
const stableHash = await sha256(path.join(distDir, stableName));
const versionedChecksum = (await readFile(path.join(distDir, `${versionedName}.sha256`), "utf8")).trim();
const stableChecksum = (await readFile(path.join(distDir, `${stableName}.sha256`), "utf8")).trim();

assert.equal(stableHash, versionedHash, "Stable MCPB alias must be byte-identical to the versioned artifact.");
assert.equal(versionedChecksum, `${versionedHash}  ${versionedName}`);
assert.equal(stableChecksum, `${stableHash}  ${stableName}`);

console.log(`Release artifacts passed for ${versionedName} and ${stableName}`);
