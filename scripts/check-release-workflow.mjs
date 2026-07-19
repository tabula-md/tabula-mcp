import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/release.yml", "utf8");
const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");

for (const required of [
  '      - "v*"',
  "contents: write",
  "id-token: write",
  "actions/checkout@v6",
  "actions/setup-node@v6",
  "node-version: 24",
  "package-manager-cache: false",
  "npm install --global npm@latest",
  "scripts/export-release-manifest.mjs",
  "scripts/check-release-secrets.mjs",
  'node scripts/check-release-contract.mjs --tag "$GITHUB_REF_NAME"',
  "npm run release:verify",
  "steps.manifest.outputs.tabula_md_ref",
  "steps.manifest.outputs.tabula_room_ref",
  "steps.manifest.outputs.tabula_json_ref",
  "scripts/check-interoperability-checkouts.mjs",
  "Rebuild release artifacts after interoperability test",
  "npm run release:pack",
  "build:release-manifest",
  "scripts/publish-npm-release.mjs",
  "gh release create",
  "gh release upload",
  "--clobber",
  "dist/tabula-mcp.mcpb",
  "dist/release-manifest.json",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "npm run deploy:cloudflare",
  "Restore resolved manifest after Worker build",
  "scripts/verify-tabula-md-production.mjs",
  "scripts/smoke-production-collab.mjs",
  "scripts/verify-published-release.mjs",
]) {
  assert.ok(workflow.includes(required), `Release workflow is missing: ${required}`);
}

assert.ok(!workflow.includes("NPM_TOKEN"), "Trusted publishing must not depend on a long-lived npm token.");

const assertOrdered = (first, second) => {
  const firstIndex = workflow.indexOf(first);
  const secondIndex = workflow.indexOf(second);
  assert.ok(firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex, `${first} must run before ${second}.`);
};

assertOrdered("npm run test:e2e:local-collab", "Rebuild release artifacts after interoperability test");
assertOrdered("Rebuild release artifacts after interoperability test", "Create GitHub Release and upload MCPB artifacts");
assertOrdered("npm run deploy:cloudflare", "Restore resolved manifest after Worker build");
assertOrdered("Resolve release provenance", "scripts/verify-tabula-md-production.mjs");
assertOrdered("scripts/verify-tabula-md-production.mjs", "scripts/publish-npm-release.mjs");
assertOrdered("Restore resolved manifest after Worker build", "Verify npm, GitHub, and production surfaces");
assertOrdered("Restore resolved manifest after Worker build", "scripts/smoke-production-collab.mjs");
assertOrdered("scripts/smoke-production-collab.mjs", "Verify npm, GitHub, and production surfaces");

for (const required of [
  "scripts/export-release-manifest.mjs",
  "steps.manifest.outputs.tabula_md_ref",
  "steps.manifest.outputs.tabula_room_ref",
  "steps.manifest.outputs.tabula_json_ref",
  "scripts/check-interoperability-checkouts.mjs",
]) {
  assert.ok(ciWorkflow.includes(required), `CI workflow is missing pinned interoperability input: ${required}`);
}

console.log("Release workflow contract passed");
