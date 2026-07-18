import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [path.join(root, "src"), path.join(root, "workers")];
const files = [];

const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(target);
  }
};
await Promise.all(sourceRoots.map(visit));

const violations = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/console\.(?:log|warn|error|info|debug)\([\s\S]{0,500}?\);/g)) {
    const call = match[0];
    if (/(roomUrl|copyUrl|shareUrl|snapshotKey|roomKey|authorization)/i.test(call) &&
      !file.endsWith("operational-policy.ts")) {
      violations.push(`${path.relative(root, file)} contains a console call near a secret-bearing identifier`);
    }
  }
}

const policySource = await readFile(path.join(root, "src/server/operational-policy.ts"), "utf8");
for (const required of ["#(room|json)=", "sensitiveLogKeyPattern", "sanitizeOperationalLogEntry"]) {
  if (!policySource.includes(required)) violations.push(`operational redaction is missing ${required}`);
}

if (violations.length) {
  throw new Error(`Secret boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
}
console.log(`Secret boundary check passed (${files.length} source files scanned).`);
