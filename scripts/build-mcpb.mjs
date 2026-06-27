import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const stageDir = path.join(distDir, "mcpb", "tabula-mcp");
const serverDir = path.join(stageDir, "server");
const packageJsonPath = path.join(rootDir, "package.json");
const packageLockPath = path.join(rootDir, "package-lock.json");
const manifestTemplatePath = path.join(rootDir, "mcpb", "manifest.json");

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const run = async (command, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 10,
    ...options,
  });
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
};

const copyServerFiles = async () => {
  const entries = await readdir(distDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.endsWith(".js") || entry.name === "room-view.html") {
      await cp(path.join(distDir, entry.name), path.join(serverDir, entry.name));
    }
  }
};

const writeBundlePackage = async (pkg) => {
  await writeFile(path.join(stageDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
};

const main = async () => {
  const pkg = await readJson(packageJsonPath);
  const manifest = await readJson(manifestTemplatePath);
  const outputFile = path.join(distDir, `tabula-mcp-${pkg.version}.mcpb`);

  await rm(stageDir, { recursive: true, force: true });
  await rm(outputFile, { force: true });
  await mkdir(serverDir, { recursive: true });

  await copyServerFiles();
  await cp(path.join(rootDir, "README.md"), path.join(stageDir, "README.md"));
  await cp(path.join(rootDir, "LICENSE"), path.join(stageDir, "LICENSE"));
  await cp(packageLockPath, path.join(stageDir, "package-lock.json"));
  await writeBundlePackage(pkg);

  await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--fund=false"], {
    cwd: stageDir,
  });

  await writeBundlePackage({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: pkg.type,
    private: true,
    engines: pkg.engines,
    dependencies: pkg.dependencies,
  });

  manifest.version = pkg.version;
  await writeFile(path.join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(stageDir, ".mcpbignore"), "package-lock.json\nnode_modules/.package-lock.json\n");

  await run("npx", ["mcpb", "validate", stageDir]);
  await run("npx", ["mcpb", "pack", stageDir, outputFile]);
  await run("npx", ["mcpb", "info", outputFile]);

  console.log(`MCPB written to ${path.relative(rootDir, outputFile)}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
