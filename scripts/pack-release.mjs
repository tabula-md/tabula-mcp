import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(rootDir, "package.json");
const distDir = path.join(rootDir, "dist");

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const runNpmScript = async (scriptName) => {
  const { stdout, stderr } = await execFileAsync("npm", ["run", scriptName], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 20,
  });

  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
};

const sha256File = async (filePath) => {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
};

const main = async () => {
  const pkg = await readJson(packageJsonPath);
  const mcpbFilename = `tabula-mcp-${pkg.version}.mcpb`;
  const mcpbPath = path.join(distDir, mcpbFilename);
  const checksumPath = `${mcpbPath}.sha256`;
  const stableFilename = "tabula-mcp.mcpb";
  const stablePath = path.join(distDir, stableFilename);
  const stableChecksumPath = `${stablePath}.sha256`;

  await runNpmScript("build:mcpb");
  await runNpmScript("check:exports");
  await runNpmScript("check:pack");
  await runNpmScript("check:mcpb");

  const checksum = await sha256File(mcpbPath);
  await writeFile(checksumPath, `${checksum}  ${mcpbFilename}\n`, "utf8");
  await copyFile(mcpbPath, stablePath);
  await writeFile(stableChecksumPath, `${checksum}  ${stableFilename}\n`, "utf8");

  console.log(`Release artifacts written to ${path.relative(rootDir, mcpbPath)} and ${path.relative(rootDir, stablePath)}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
