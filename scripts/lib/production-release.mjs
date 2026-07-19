import assert from "node:assert/strict";

const commitPattern = /^[0-9a-f]{40}$/;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const validateTabulaMdProduction = (buildInfo, releaseManifest) => {
  const expected = releaseManifest.interoperability?.tabulaMd;
  assert(expected, "Release manifest must pin Tabula.md production.");
  assert.match(expected.ref, commitPattern, "Tabula.md production ref must be a full Git commit SHA.");
  assert.match(expected.origin, /^https:\/\//, "Tabula.md production origin must use HTTPS.");

  assert(buildInfo && typeof buildInfo === "object", "Tabula.md build provenance must be a JSON object.");
  assert.equal(buildInfo.schemaVersion, 1, "Tabula.md build provenance schema is unsupported.");
  assert.equal(buildInfo.service, "tabula-md", "Tabula.md build provenance identifies the wrong service.");
  assert.equal(
    buildInfo.commit,
    expected.ref,
    `Tabula.md production commit ${buildInfo.commit ?? "unknown"} does not match pinned ${expected.ref}.`,
  );
  assert.equal(
    buildInfo.coreVersion,
    releaseManifest.packages?.core?.version,
    "Tabula.md production and Tabula MCP do not use the same @tabula-md/tabula version.",
  );
  assert.match(buildInfo.appVersion, /^\d+\.\d+\.\d+$/, "Tabula.md production app version must be semver.");

  return buildInfo;
};

export const waitForTabulaMdProduction = async ({
  releaseManifest,
  attempts = 12,
  intervalMs = 5_000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
}) => {
  const expected = releaseManifest.interoperability.tabulaMd;
  const origin = expected.origin.replace(/\/$/, "");
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(
        `${origin}/.well-known/tabula-build.json?commit=${expected.ref}&attempt=${attempt}`,
        {
          headers: { "cache-control": "no-cache" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(response.status, 200, `Tabula.md build provenance returned HTTP ${response.status}.`);
      return validateTabulaMdProduction(await response.json(), releaseManifest);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleepImpl(intervalMs);
    }
  }

  throw new Error(
    `Tabula.md production did not match the pinned release contract after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`,
  );
};
