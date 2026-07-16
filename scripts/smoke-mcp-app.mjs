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
    "titleInput",
    "mcp-chrome",
    "mcp-document-title",
    "room-handoff-action",
    "markdownPreview",
    "data-view-mode",
    "shareDocumentButton",
    "openTabulaButton",
    "tabulaWorkbench",
  ]) {
    assertIncludes(appHtml, expected, "document app source");
    assertIncludes(devHtml, expected, "dev harness");
    assertIncludes(builtHtml, expected, "built document app");
  }

  for (const expected of ["tabula_app_save_document", "tabula_share_document", "updateModelContext"]) {
    assertIncludes(mockApp, expected, "mock app bridge");
  }

  assertIncludes(devHtml, "/src/app-dev/main.js", "dev harness");
  assertIncludes(builtHtml, "No Markdown content", "built document app");
  if (builtHtml.includes("dev-only-not-a-real-key")) {
    throw new Error("built document app includes dev-only share fixture");
  }

  console.log("MCP App smoke passed");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
