import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { createServer } from "vite";

const host = "127.0.0.1";

const waitForMessage = async (page, text) => {
  await page.locator("#message", { hasText: text }).waitFor({ state: "visible" });
};

const getDevEvents = (page) =>
  page.evaluate(() => ({
    toolCalls: window.__TABULA_DEV_TOOL_CALLS__ || [],
    modelContexts: window.__TABULA_DEV_MODEL_CONTEXTS__ || [],
    displayModes: window.__TABULA_DEV_DISPLAY_MODES__ || [],
  }));

const installDevEventCapture = async (page) => {
  await page.addInitScript(() => {
    window.__TABULA_DEV_TOOL_CALLS__ = [];
    window.__TABULA_DEV_MODEL_CONTEXTS__ = [];
    window.__TABULA_DEV_DISPLAY_MODES__ = [];
    window.addEventListener("tabula-dev:tool-call", (event) => {
      window.__TABULA_DEV_TOOL_CALLS__.push(event.detail);
    });
    window.addEventListener("tabula-dev:model-context", (event) => {
      window.__TABULA_DEV_MODEL_CONTEXTS__.push(event.detail);
    });
    window.addEventListener("tabula-dev:display-mode", (event) => {
      window.__TABULA_DEV_DISPLAY_MODES__.push(event.detail);
    });
  });
};

const createPage = async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon.ico")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installDevEventCapture(page);
  return { page, consoleErrors, pageErrors };
};

const assertNoPageErrors = (consoleErrors, pageErrors) => {
  assert.deepEqual(pageErrors, [], "dev harness should not throw page errors");
  assert.deepEqual(consoleErrors, [], "dev harness should not log browser console errors");
};

const runDocumentFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
  await waitForMessage(page, "Tabula.md document is ready.");

  const markdown = [
    "# Flow Smoke",
    "",
    "Edited from browser smoke.",
    "",
    "<!-- tabula-comment: check browser flow -->",
    "",
    "## Next",
    "",
    "- Save",
    "- Share",
  ].join("\n");

  await page.locator("#titleInput").fill("Flow Smoke");
  await page.locator("#markdownEditor").fill(markdown);
  await waitForMessage(page, "Document has unsaved changes.");
  await page.getByRole("button", { name: "Save" }).click();
  await waitForMessage(page, "Document saved in this MCP session.");

  await page.getByRole("button", { name: "Send Changes" }).click();
  await waitForMessage(page, "Document changes sent to the model context.");

  await page.getByRole("button", { name: "Comments" }).click();
  await page.locator("#commentsList").getByText("check browser flow", { exact: true }).click();
  await page.getByRole("button", { name: "Send Comment" }).click();
  await waitForMessage(page, "Comment sent to the model context.");

  await page.getByRole("button", { name: "Share" }).click();
  await waitForMessage(page, "Encrypted share link sent to the model context.");

  const events = await getDevEvents(page);
  const toolNames = events.toolCalls.map((call) => call?.name);
  assert(toolNames.includes("tabula_app_save_document"), "document flow should save through the App bridge");
  assert(toolNames.includes("tabula_share_document"), "document flow should share through the App bridge");

  const documentChange = events.modelContexts.find((payload) => payload?.structuredContent?.tabulaDocumentChange);
  assert(documentChange, "document flow should send compact change context");
  assert.equal(documentChange.structuredContent.tabulaDocumentChange.summary.changed, true);
  assert(
    !JSON.stringify(documentChange).includes(`${markdown}\n`),
    "document change context should not include the full Markdown body",
  );

  const comment = events.modelContexts.find((payload) => payload?.structuredContent?.tabulaComment);
  assert(comment, "document flow should send selected comment context");
  assert.equal(comment.structuredContent.tabulaComment.comment.text, "check browser flow");
  assert(
    !JSON.stringify(comment).includes("Edited from browser smoke"),
    "comment context should not include unrelated Markdown body text",
  );

  const share = events.modelContexts.find((payload) => payload?.structuredContent?.tabulaShare);
  assert(share, "document flow should send encrypted share context");
  assert.equal(share.structuredContent.tabulaShare.encrypted, true);
  assert.match(share.structuredContent.tabulaShare.shareUrl, /#key=/);

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runRoomFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1&fixture=room`);
  await waitForMessage(page, "Tabula.md content is current.");

  await page.getByRole("button", { name: "Refresh" }).click();
  await waitForMessage(page, "Tabula.md content is current.");

  const isReadOnly = await page.locator("#markdownEditor").evaluate((element) => element.readOnly);
  assert.equal(isReadOnly, true, "room fixture must open in read-only mode");
  await page.getByRole("button", { name: "Fullscreen" }).click();
  await page.getByRole("button", { name: "Inline" }).waitFor({ state: "visible" });

  const events = await getDevEvents(page);
  assert(
    events.toolCalls.some((call) => call?.name === "tabula_app_room_snapshot"),
    "room flow should refresh through the room snapshot tool",
  );
  assert(
    events.displayModes.some((event) => event?.mode === "fullscreen"),
    "room flow should exercise display mode requests",
  );

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const main = async () => {
  const server = await createServer({
    configFile: "vite.config.dev.mjs",
    server: {
      host,
      port: 0,
      strictPort: false,
    },
    logLevel: "silent",
  });

  let browser;
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
    assert(baseUrl, "Vite dev server did not expose a local URL");
    browser = await chromium.launch({ headless: true });
    await runDocumentFlow(baseUrl, browser);
    await runRoomFlow(baseUrl, browser);
  } catch (error) {
    if (String(error?.message || error).includes("Executable doesn't exist")) {
      throw new Error("Playwright Chromium is not installed. Run `npx playwright install chromium`.");
    }
    throw error;
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log("MCP App browser flow smoke passed");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
