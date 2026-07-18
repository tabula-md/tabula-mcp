import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { githubOutputsForManifest, loadReleaseManifest } from "./lib/release-manifest.mjs";

const manifest = await loadReleaseManifest();
const outputs = githubOutputsForManifest(manifest);
assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required.");
await appendFile(
  process.env.GITHUB_OUTPUT,
  `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  "utf8",
);
