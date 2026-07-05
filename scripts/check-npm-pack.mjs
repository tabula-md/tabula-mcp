import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const requiredFiles = [
  "assets/icon.png",
  "dist/index.js",
  "dist/index.d.ts",
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
  "dist/documents/index.js",
  "dist/documents/index.d.ts",
  "dist/document-app.html",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
];

const isForbiddenGeneratedArtifact = (filePath) =>
  filePath.startsWith("dist/mcpb/") ||
  filePath.endsWith(".mcpb") ||
  filePath.endsWith(".mcpb.sha256") ||
  filePath.includes("/node_modules/");

const main = async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    maxBuffer: 1024 * 1024 * 20,
  });
  const pack = JSON.parse(stdout)[0];
  const paths = new Set(pack.files.map((file) => file.path));

  for (const filePath of requiredFiles) {
    if (!paths.has(filePath)) {
      throw new Error(`npm package is missing ${filePath}`);
    }
  }

  const forbidden = [...paths].filter(isForbiddenGeneratedArtifact);
  if (forbidden.length) {
    throw new Error(`npm package includes generated artifacts: ${forbidden.slice(0, 8).join(", ")}`);
  }

  console.log(`npm package contents check passed (${pack.entryCount} files)`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
