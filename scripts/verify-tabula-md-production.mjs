import { readFile } from "node:fs/promises";
import { waitForTabulaMdProduction } from "./lib/production-release.mjs";

const releaseManifest = JSON.parse(await readFile("dist/release-manifest.json", "utf8"));
const buildInfo = await waitForTabulaMdProduction({ releaseManifest });

console.log(
  `Pinned Tabula.md production verified at ${buildInfo.commit} with @tabula-md/tabula ${buildInfo.coreVersion}.`,
);
