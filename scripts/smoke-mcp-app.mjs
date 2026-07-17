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
    "handoffEyebrow",
    "handoffMeta",
    "openButton",
  ]) {
    assertIncludes(appHtml, expected, "session card source");
    assertIncludes(devHtml, expected, "dev harness");
    assertIncludes(builtHtml, expected, "built session card");
  }

  for (const expected of ["copyFixture", "roomFixture", "openLink"]) {
    assertIncludes(mockApp, expected, "mock app bridge");
  }
  const appSource = await readText("src/app/document-app.js");
  if (appSource.includes("callServerTool")) {
    throw new Error("handoff App must not call server tools from a host-specific MCP context");
  }

  assertIncludes(devHtml, "/src/app-dev/main.js", "dev harness");
  assertIncludes(builtHtml, ">Tabula<", "built session card");
  if (builtHtml.includes("Tabula.md</span>") || builtHtml.includes("sessionTitle") || builtHtml.includes("handoffSummary")) {
    throw new Error("built session card must stay a compact Tabula handoff receipt without a document title or summary block");
  }
  assertIncludes(builtHtml, "Encrypted copy", "built handoff card");
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
