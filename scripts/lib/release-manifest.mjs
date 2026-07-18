import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shaPattern = /^[0-9a-f]{40}$/;

export const loadReleaseManifest = async (filePath = "release-manifest.json") => {
  const manifest = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Release manifest schemaVersion must be 1.");
  assert.match(manifest.releaseVersion, /^\d+\.\d+\.\d+$/, "Release manifest version must be semver.");
  assert.equal(manifest.packages?.mcp?.name, "@tabula-md/mcp");
  assert.equal(manifest.packages?.core?.name, "@tabula-md/tabula");
  assert.equal(manifest.worker?.name, "tabula-mcp");
  assert.match(manifest.worker?.origin, /^https:\/\//, "Worker origin must use HTTPS.");
  assert.match(manifest.worker?.healthPath, /^\//, "Worker healthPath must be absolute.");
  assert.match(manifest.worker?.readyPath, /^\//, "Worker readyPath must be absolute.");
  assert.match(manifest.worker?.mcpPath, /^\//, "Worker mcpPath must be absolute.");
  for (const [name, dependency] of Object.entries(manifest.interoperability ?? {})) {
    assert.match(dependency.repository, /^[\w.-]+\/[\w.-]+$/, `${name} repository must be owner/name.`);
    assert.match(dependency.ref, shaPattern, `${name} ref must be an immutable 40-character commit SHA.`);
  }
  assert.equal(Object.keys(manifest.interoperability ?? {}).length, 3, "Release manifest must pin three companion repositories.");
  return manifest;
};

export const githubOutputsForManifest = (manifest) => ({
  version: manifest.releaseVersion,
  tabula_md_repository: manifest.interoperability.tabulaMd.repository,
  tabula_md_ref: manifest.interoperability.tabulaMd.ref,
  tabula_room_repository: manifest.interoperability.tabulaRoom.repository,
  tabula_room_ref: manifest.interoperability.tabulaRoom.ref,
  tabula_json_repository: manifest.interoperability.tabulaJson.repository,
  tabula_json_ref: manifest.interoperability.tabulaJson.ref,
});

export const resolveReleaseTag = ({ version, suppliedTag, environmentRefName }) => {
  const environmentTag = /^v\d+\.\d+\.\d+$/.test(environmentRefName ?? "") ? environmentRefName : undefined;
  return suppliedTag ?? environmentTag ?? `v${version}`;
};
