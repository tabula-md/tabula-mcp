import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const requiredFiles = [
  "assets/icon.png",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/cli.js",
  "dist/cli.d.ts",
  "dist/env.js",
  "dist/env.d.ts",
  "dist/server/index.js",
  "dist/server/index.d.ts",
  "dist/server/http.js",
  "dist/server/http.d.ts",
  "dist/server/operational-policy.js",
  "dist/server/operational-policy.d.ts",
  "dist/server/origin-policy.js",
  "dist/server/origin-policy.d.ts",
  "dist/server/web.js",
  "dist/server/web.d.ts",
  "dist/protocol.js",
  "dist/protocol.d.ts",
  "dist/deployment.js",
  "dist/deployment.d.ts",
  "dist/markdown-limits.js",
  "dist/markdown-limits.d.ts",
  "dist/document-app.html",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "release-manifest.json",
];

const isForbiddenGeneratedArtifact = (filePath) =>
  filePath.startsWith("dist/mcpb/") ||
  filePath.endsWith(".mcpb") ||
  filePath.endsWith(".mcpb.sha256") ||
  filePath.includes("/node_modules/");

const sensitiveContentPatterns = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "live room secret", pattern: /#room=[A-Za-z0-9_-]{8,},[A-Za-z0-9_-]{16,}/ },
  { label: "live snapshot secret", pattern: /#json=[A-Za-z0-9_-]{8,},[A-Za-z0-9_-]{16,}/ },
];

const isTextPackageFile = (filePath) => /\.(?:css|d\.ts|html|js|json|md|txt)$/i.test(filePath);

const readPackResult = (output, packageName) => {
  const parsed = JSON.parse(output);
  const pack = Array.isArray(parsed)
    ? parsed[0]
    : parsed?.[packageName] ?? Object.values(parsed ?? {})[0];

  if (!pack || !Array.isArray(pack.files)) {
    throw new Error("npm pack returned an unsupported JSON result");
  }

  return pack;
};

const main = async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    maxBuffer: 1024 * 1024 * 20,
  });
  const pack = readPackResult(stdout, packageJson.name);
  const paths = new Set(pack.files.map((file) => file.path));

  if (packageJson.name !== "@tabula-md/mcp" || packageJson.publishConfig?.access !== "public") {
    throw new Error("npm package metadata must publish @tabula-md/mcp with public access");
  }
  if (Object.keys(packageJson.bin ?? {}).length !== 1 || packageJson.bin?.["tabula-mcp"] !== "dist/cli.js") {
    throw new Error("public MCP package must expose only the tabula-mcp executable");
  }
  const publicPackageMetadata = JSON.stringify({
    bin: packageJson.bin,
    exports: packageJson.exports,
    files: packageJson.files,
    scripts: packageJson.scripts,
    workspaces: packageJson.workspaces,
  });
  if (/packages\/sync|@tabula-md\/sync|sync:dev|dist\/sync-/i.test(publicPackageMetadata)) {
    throw new Error("public MCP package metadata exposes the private Sync prototype");
  }
  if (!packageJson.repository?.url || !packageJson.bugs?.url || !packageJson.homepage) {
    throw new Error("npm package metadata is missing repository, bugs, or homepage URLs");
  }

  for (const filePath of requiredFiles) {
    if (!paths.has(filePath)) {
      throw new Error(`npm package is missing ${filePath}`);
    }
  }

  const forbidden = [...paths].filter(isForbiddenGeneratedArtifact);
  if (forbidden.length) {
    throw new Error(`npm package includes generated artifacts: ${forbidden.slice(0, 8).join(", ")}`);
  }
  const privateSyncFiles = [...paths].filter((filePath) => filePath.startsWith("dist/sync-"));
  if (privateSyncFiles.length) {
    throw new Error(`npm package exposes private Tabula Sync files: ${privateSyncFiles.join(", ")}`);
  }

  const entrypoint = await readFile(packageJson.bin["tabula-mcp"], "utf8");
  if (!entrypoint.startsWith("#!/usr/bin/env node")) {
    throw new Error("npm CLI entrypoint is missing its node shebang");
  }

  for (const filePath of paths) {
    if (!isTextPackageFile(filePath)) continue;
    const content = await readFile(filePath, "utf8");
    for (const candidate of sensitiveContentPatterns) {
      if (candidate.pattern.test(content)) {
        throw new Error(`npm package ${filePath} contains a possible ${candidate.label}`);
      }
    }
  }

  const packDirectory = await mkdtemp(path.join(tmpdir(), "tabula-mcp-pack-"));
  try {
    const { stdout: packedOutput } = await execFileAsync(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      { maxBuffer: 1024 * 1024 * 20 },
    );
    const packed = readPackResult(packedOutput, packageJson.name);
    const tarball = path.join(packDirectory, packed.filename);
    const { stdout: helpOutput, stderr: helpError } = await execFileAsync(
      "npm",
      ["exec", "--yes", `--package=${tarball}`, "--", "tabula-mcp", "--help"],
      { maxBuffer: 1024 * 1024 * 20, timeout: 30_000 },
    );
    // npm may write informational `npm notice run ...` messages to stderr even
    // when the packed CLI exits successfully. execFileAsync already rejects a
    // non-zero exit code, so validate the CLI's stdout instead of treating npm's
    // own diagnostics as an application failure.
    if (!helpOutput.includes("Tabula MCP")) {
      throw new Error(`packed package did not run through the documented npx command${helpError.trim() ? `: ${helpError.trim()}` : ""}`);
    }
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }

  console.log(`npm package contents and documented npx command passed (${pack.entryCount ?? pack.files.length} files)`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
