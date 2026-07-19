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
  "server/app/resource.js",
  "server/deployment.js",
  "server/markdown-limits.js",
  "server/server/index.js",
  "server/server/create-server.js",
  "server/server/register-core-tools.js",
  "server/server/tool-metadata.js",
  "server/server/instructions.js",
  "server/server/http.js",
  "server/server/operational-policy.js",
  "server/server/origin-policy.js",
  "server/server/web.js",
  "server/server/write-access.js",
  "server/workspace-contract.js",
  "server/workspace-file-service.js",
  "server/text-diff.js",
  "server/workspace-paths.js",
  "server/export-copy-service.js",
  "server/session-service.js",
  "server/core-errors.js",
  "server/agent-identity.js",
  "server/comments-service.js",
  "server/mutation-receipt.js",
  "server/share.js",
  "server/workspaces.js",
  "README.md",
  "PRIVACY.md",
  "LICENSE",
];

const requiredTools = [
  "start_session",
  "join_room",
  "leave_session",
  "list_files",
  "read_file",
  "read_multiple_files",
  "search_files",
  "list_comments",
  "add_comment",
  "reply_to_comment",
  "resolve_comment",
  "delete_comment",
  "write_file",
  "write_files",
  "edit_file",
  "create_directory",
  "move_file",
  "delete_path",
  "import_copy",
  "export_copy",
];

const forbiddenManifestTools = [
  "tabula_app_room_snapshot",
  "tabula_app_document_snapshot",
  "tabula_app_save_document",
  "tabula_read_me",
  "tabula_create_document",
  "tabula_update_document",
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
  "tabula_read_workspace_context",
  "tabula_apply_workspace_changes",
  "tabula_room_status",
  "tabula_open_room_view",
  "tabula_set_presence",
  "tabula_wait_for_changes",
  "tabula_disconnect_room",
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
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return tools.tools
      .filter((tool) => !isAppOnlyTool(tool))
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await client.close();
    assert(stderr.join("").trim() === "", `MCPB bundled server wrote unexpected stderr: ${stderr.join("")}`);
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
  assert(manifest.display_name === "Tabula MCP", `MCPB ${label} display name must be Tabula MCP`);
  assert(manifest.author?.name === "Tabula", `MCPB ${label} author name must be Tabula`);
  assert(!("user_config" in manifest), `MCPB ${label} manifest must not include installer user_config`);
  assert(
    Array.isArray(manifest.privacy_policies) && manifest.privacy_policies.every((policy) => /^https:\/\//.test(policy)),
    `MCPB ${label} manifest must include HTTPS privacy policy URLs`,
  );
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
  const shareToolDescription = manifest.tools?.find((tool) => tool.name === "export_copy")?.description ?? "";
  assert(
    shareToolDescription.includes("#json") && !/room share/i.test(shareToolDescription),
    `MCPB ${label} manifest export_copy description must describe fixed #json copies`,
  );
  const modelFacingTools = await listBundledModelFacingTools(bundleDir);
  assertMatchingToolNames(
    manifest.tools.map((tool) => tool.name).sort(),
    modelFacingTools.map((tool) => tool.name),
    `MCPB ${label} manifest tools must match the bundled direct-collaboration server's model-facing tools`,
  );
  for (const tool of modelFacingTools) {
    const manifestTool = manifest.tools.find((candidate) => candidate.name === tool.name);
    assert(
      manifestTool?.description === tool.description,
      `MCPB ${label} manifest description for ${tool.name} must match the bundled runtime`,
    );
    assert(typeof tool.title === "string" && tool.title.trim(), `MCPB ${label} tool ${tool.name} must have a display title`);
    assert(tool.outputSchema, `MCPB ${label} tool ${tool.name} must have an output schema`);
    assert(tool.annotations, `MCPB ${label} tool ${tool.name} must have safety annotations`);
    for (const annotation of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert(
        typeof tool.annotations[annotation] === "boolean",
        `MCPB ${label} tool ${tool.name} must declare ${annotation}`,
      );
    }
  }

  const appHtml = await readFile(path.join(bundleDir, "server", "document-app.html"), "utf8");
  const icon = await readFile(path.join(bundleDir, "assets", "icon.png"));
  assert(icon.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), `MCPB ${label} icon must be a PNG file`);
  for (const expected of [
    "tabulaMark",
    "handoffEyebrow",
    "handoffMeta",
    "openButton",
  ]) {
    assert(appHtml.includes(expected), `MCPB ${label} Document App is missing ${expected}`);
  }
  assert(appHtml.includes(">Tabula<"), `MCPB ${label} Document App must use the Tabula brand`);
  assert(!appHtml.includes("handoffSummary"), `MCPB ${label} Document App must stay a compact handoff receipt`);
  assert(!appHtml.includes("sessionTitle"), `MCPB ${label} Document App must not present a document title in its chrome`);
  for (const toolName of ["start_session", "export_copy"]) {
    assert(!appHtml.includes(toolName), `MCPB ${label} Document App must not embed a stateful tool call to ${toolName}`);
  }
  assert(!appHtml.includes("TabulaEmbeddedDocumentWorkbench"), `MCPB ${label} must not bundle a second Tabula editor`);
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
