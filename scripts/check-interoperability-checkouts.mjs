import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadReleaseManifest } from "./lib/release-manifest.mjs";

const execFileAsync = promisify(execFile);
const manifest = await loadReleaseManifest();
const checkouts = [
  ["deps/tabula-md", manifest.interoperability.tabulaMd.ref],
  ["deps/tabula-room", manifest.interoperability.tabulaRoom.ref],
  ["deps/tabula-json", manifest.interoperability.tabulaJson.ref],
];

for (const [directory, expected] of checkouts) {
  const actual = (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
  assert.equal(actual, expected, `${directory} must be checked out at the release-manifest ref.`);
}
console.log("Pinned interoperability checkouts verified");
