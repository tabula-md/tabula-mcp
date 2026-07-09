import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const stageBundleDir = path.join(distDir, "mcpb", "tabula-mcp");
const stdioSmokeScript = path.join(rootDir, "scripts", "smoke-stdio-server.mjs");
const execFileAsync = promisify(execFile);

const requiredFiles = [
  "manifest.json",
  "assets/icon.png",
  "server/index.js",
  "server/cli.js",
  "server/document-app.html",
  "server/env.js",
  "server/app/tools.js",
  "server/app/resource.js",
  "server/documents/index.js",
  "server/documents/registry.js",
  "server/documents/store.js",
  "server/server/index.js",
  "server/server/create-server.js",
  "server/server/http.js",
  "server/server/operational-policy.js",
  "server/server/origin-policy.js",
  "server/server/web.js",
  "server/server/register-room-tools.js",
  "server/server/write-access.js",
  "server/room-events.js",
  "server/share.js",
  "server/workspaces.js",
  "server/guidance.js",
  "server/output-schemas.js",
  "README.md",
  "docs/codex-cli.md",
  "docs/claude-desktop.md",
  "docs/security-model.md",
  "docs/mcp-app-architecture.md",
  "docs/release.md",
  "LICENSE",
];

const requiredTools = [
  "tabula_read_me",
  "tabula_create_document",
  "tabula_list_documents",
  "tabula_open_document",
  "tabula_share_document",
  "tabula_create_workspace",
  "tabula_import_markdown_workspace",
  "tabula_share_workspace",
  "tabula_create_workspace_room",
  "tabula_connect_room",
  "tabula_list_sessions",
  "tabula_read_workspace",
  "tabula_read_workspace_document",
  "tabula_propose_workspace_changes",
  "tabula_room_status",
  "tabula_open_room_view",
  "tabula_set_presence",
  "tabula_wait_for_changes",
  "tabula_disconnect_room",
];

const forbiddenManifestTools = [
  "tabula_app_room_snapshot",
  "tabula_app_document_snapshot",
  "tabula_app_save_document",
  "tabula_read_markdown",
  "tabula_get_outline",
  "tabula_propose_text_patches",
  "tabula_apply_text_patches",
];

const forbiddenArtifactFiles = ["package-lock.json", "node_modules/.package-lock.json"];

const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const readJson = async (baseDir, relativePath) => JSON.parse(await readFile(path.join(baseDir, relativePath), "utf8"));

const readRootJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const relativeFromRoot = (filePath) => path.relative(rootDir, filePath);

const run = async (command, args) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
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

const isAppOnlyTool = (tool) => tool._meta?.ui?.visibility?.includes("app");

const listBundledModelFacingTools = async (bundleDir) => {
  const client = new Client(
    { name: "tabula-mcp-mcpb-check", version: "0.0.0" },
    { capabilities: uiCapabilities },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(bundleDir, "server", "index.js")],
    cwd: bundleDir,
    env: {
      TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS: "1",
    },
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return tools.tools
      .filter((tool) => !isAppOnlyTool(tool))
      .map((tool) => tool.name)
      .sort();
  } finally {
    await client.close();
    assert(
      stderr.every((line) => line.includes("ExperimentalWarning: localStorage is not available")),
      `MCPB bundled server wrote unexpected stderr: ${stderr.join("")}`,
    );
  }
};

const assertMatchingToolNames = (actual, expected, messagePrefix) => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((toolName) => !actualSet.has(toolName));
  const extra = actual.filter((toolName) => !expectedSet.has(toolName));

  assert(
    missing.length === 0 && extra.length === 0,
    `${messagePrefix}. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}`,
  );
};

const checkBundleDir = async (bundleDir, label, rootPackage) => {
  for (const relativePath of requiredFiles) {
    assert(existsSync(path.join(bundleDir, relativePath)), `MCPB ${label} is missing ${relativePath}`);
  }

  for (const dependencyName of Object.keys(rootPackage.dependencies ?? {})) {
    assert(
      existsSync(path.join(bundleDir, "node_modules", ...dependencyName.split("/"), "package.json")),
      `MCPB ${label} is missing production dependency ${dependencyName}`,
    );
  }

  const manifest = await readJson(bundleDir, "manifest.json");
  const bundlePackage = await readJson(bundleDir, "package.json");
  assert(!("user_config" in manifest), `MCPB ${label} manifest must not include installer user_config`);
  assert(manifest.icon === "assets/icon.png", `MCPB ${label} manifest must point icon to assets/icon.png`);
  assert(
    manifest.icons?.some((icon) => icon.src === "assets/icon.png" && icon.size === "512x512"),
    `MCPB ${label} manifest must include a 512x512 icon entry`,
  );
  assert(manifest.server?.mcp_config?.command === "node", `MCPB ${label} server command must be node`);
  assert(
    manifest.server?.mcp_config?.args?.includes("${__dirname}/server/index.js"),
    `MCPB ${label} server args must point to bundled server/index.js`,
  );
  assert(
    manifest.compatibility?.runtimes?.node === rootPackage.engines?.node,
    `MCPB ${label} manifest Node runtime must match package engines.node`,
  );
  assert(
    bundlePackage.engines?.node === rootPackage.engines?.node,
    `MCPB ${label} bundled package Node engine must match root package engines.node`,
  );
  assert(
    JSON.stringify(manifest.compatibility?.platforms) === JSON.stringify(["darwin", "win32"]),
    `MCPB ${label} one-click compatibility must stay limited to verified macOS and Windows targets`,
  );

  const toolNames = new Set(manifest.tools?.map((tool) => tool.name));
  for (const toolName of requiredTools) {
    assert(toolNames.has(toolName), `MCPB ${label} manifest is missing tool ${toolName}`);
  }
  for (const toolName of forbiddenManifestTools) {
    assert(!toolNames.has(toolName), `MCPB ${label} manifest must not list ${toolName}`);
  }
  const shareToolDescription = manifest.tools?.find((tool) => tool.name === "tabula_share_document")?.description ?? "";
  assert(
    shareToolDescription.includes("JSON snapshot") && !/room share/i.test(shareToolDescription),
    `MCPB ${label} manifest tabula_share_document description must describe JSON snapshot sharing`,
  );
  const modelFacingTools = await listBundledModelFacingTools(bundleDir);
  assertMatchingToolNames(
    manifest.tools.map((tool) => tool.name).sort(),
    modelFacingTools,
    `MCPB ${label} manifest tools must match the bundled proposal-first server's model-facing tools`,
  );

  const appHtml = await readFile(path.join(bundleDir, "server", "document-app.html"), "utf8");
  const icon = await readFile(path.join(bundleDir, "assets", "icon.png"));
  assert(icon.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), `MCPB ${label} icon must be a PNG file`);
  for (const expected of ["titleInput", "markdownPreview", "data-view-mode", "shareDocumentButton"]) {
    assert(appHtml.includes(expected), `MCPB ${label} Document App is missing ${expected}`);
  }
  assert(!appHtml.includes("dev-only-not-a-real-key"), `MCPB ${label} Document App includes dev-only fixture data`);
  assert(!appHtml.includes("/src/app-dev/"), `MCPB ${label} Document App includes dev harness source paths`);
};

const checkPackedArtifact = async (artifactPath, rootPackage) => {
  assert(existsSync(artifactPath), `MCPB artifact is missing ${relativeFromRoot(artifactPath)}; run npm run build:mcpb first`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tabula-mcp-mcpb-"));
  try {
    await run("npx", ["mcpb", "unpack", artifactPath, tempDir]);
    for (const relativePath of forbiddenArtifactFiles) {
      assert(!existsSync(path.join(tempDir, relativePath)), `MCPB packed artifact must not include ${relativePath}`);
    }
    await checkBundleDir(tempDir, "packed artifact", rootPackage);
    await run("node", [
      stdioSmokeScript,
      "--server-entrypoint",
      path.join(tempDir, "server", "index.js"),
      "--server-cwd",
      tempDir,
      "--label",
      "Packed MCPB stdio server",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const main = async () => {
  const rootPackage = await readRootJson("package.json");
  const artifactPath = path.join(distDir, `tabula-mcp-${rootPackage.version}.mcpb`);

  await checkBundleDir(stageBundleDir, "staged bundle", rootPackage);
  await checkPackedArtifact(artifactPath, rootPackage);

  console.log("MCPB staged bundle and packed artifact checks passed");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
