import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readText = async (relativePath) => readFile(path.join(rootDir, relativePath), "utf8");

const assertIncludes = (text, expected, label) => {
  if (!text.includes(expected)) {
    throw new Error(`${label} is missing ${expected}`);
  }
};

const main = async () => {
  const [devHtml, mockApp, appHtml, builtHtml] = await Promise.all([
    readText("index-dev.html"),
    readText("src/app-dev/mock-app.js"),
    readText("src/app/document-app.html"),
    readText("dist/document-app.html"),
  ]);

  for (const expected of [
    "tabulaMark",
    "sessionEyebrow",
    "documentMeta",
    "collaborationMeta",
    "openCopyButton",
    "startSessionButton",
    "openSessionButton",
  ]) {
    assertIncludes(appHtml, expected, "session card source");
    assertIncludes(devHtml, expected, "dev harness");
    assertIncludes(builtHtml, expected, "built session card");
  }

  for (const expected of ["tabula_share_document", "tabula_app_start_room_from_document", "openLink"]) {
    assertIncludes(mockApp, expected, "mock app bridge");
  }

  assertIncludes(devHtml, "/src/app-dev/main.js", "dev harness");
  assertIncludes(builtHtml, ">Tabula<", "built session card");
  if (builtHtml.includes("Tabula.md</span>") || builtHtml.includes("sessionTitle")) {
    throw new Error("built session card must use the centered Tabula brand without a document title header");
  }
  assertIncludes(builtHtml, "Private draft", "built session card");
  if (builtHtml.includes("TabulaEmbeddedDocumentWorkbench") || builtHtml.includes("data-tabula-document-workbench")) {
    throw new Error("built session card must not bundle a second Tabula editor");
  }
  if (builtHtml.includes("dev-only-not-a-real-key")) {
    throw new Error("built session card includes dev-only share fixture");
  }

  console.log("MCP App smoke passed");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
