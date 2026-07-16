import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { createServer } from "vite";

const host = "127.0.0.1";

const waitForMessage = async (page, text) => {
  await page.locator("#message", { hasText: text }).waitFor({ state: "attached" });
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

const desktopViewport = { width: 1280, height: 720 };
const mobileViewport = { width: 390, height: 844 };

const createPage = async (browser, viewport = desktopViewport) => {
  const page = await browser.newPage({ viewport });
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

const assertNoHorizontalOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const shell = document.querySelector(".shell");

    return {
      viewportWidth: window.innerWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      shellScrollWidth: shell?.scrollWidth ?? 0,
      visibleButtons: [...document.querySelectorAll("button")]
        .filter((button) => button.offsetParent !== null)
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            text: button.textContent?.trim() ?? "",
            left: rect.left,
            right: rect.right,
            width: rect.width,
          };
        }),
    };
  });

  const tolerance = 2;
  assert(
    overflow.rootScrollWidth <= overflow.viewportWidth + tolerance,
    `${label} root should not overflow horizontally: ${JSON.stringify(overflow)}`,
  );
  assert(
    overflow.bodyScrollWidth <= overflow.viewportWidth + tolerance,
    `${label} body should not overflow horizontally: ${JSON.stringify(overflow)}`,
  );
  assert(
    overflow.shellScrollWidth <= overflow.viewportWidth + tolerance,
    `${label} shell should not overflow horizontally: ${JSON.stringify(overflow)}`,
  );

  for (const button of overflow.visibleButtons) {
    assert(button.width > 0, `${label} visible button should have a stable width: ${button.text}`);
    assert(
      button.left >= -tolerance && button.right <= overflow.viewportWidth + tolerance,
      `${label} visible button should stay inside the viewport: ${JSON.stringify(button)}`,
    );
  }
};

const assertNoPageErrors = (consoleErrors, pageErrors) => {
  assert.deepEqual(pageErrors, [], "dev harness should not throw page errors");
  assert.deepEqual(consoleErrors, [], "dev harness should not log browser console errors");
};

const assertInlineDocumentPresentation = async (page, label) => {
  const presentation = await page.evaluate(() => {
    const preview = document.querySelector(".markdown-preview");
    const status = document.querySelector(".status-grid");
    const context = document.querySelector(".context-pane");
    const shell = document.querySelector(".shell");
    const toolbar = document.querySelector(".toolbar");

    return {
      contextDisplay: context ? window.getComputedStyle(context).display : "missing",
      previewHeight: preview?.getBoundingClientRect().height ?? 0,
      previewMaxHeight: preview ? window.getComputedStyle(preview).maxHeight : "missing",
      shellMinHeight: shell ? window.getComputedStyle(shell).minHeight : "missing",
      statusDisplay: status ? window.getComputedStyle(status).display : "missing",
      toolbarHeight: toolbar?.getBoundingClientRect().height ?? 0,
    };
  });

  assert.equal(presentation.statusDisplay, "none", `${label} should hide MCP implementation status`);
  assert.equal(presentation.contextDisplay, "none", `${label} should show the document, not a fake side panel`);
  assert.equal(presentation.previewMaxHeight, "420px", `${label} should bound the inline preview`);
  assert(presentation.previewHeight <= 420, `${label} preview should not consume the host viewport`);
  assert.notEqual(presentation.shellMinHeight, "100vh", `${label} should not reserve a desktop-sized inline app`);
  assert(presentation.toolbarHeight <= 48, `${label} should keep continuation controls compact`);
};

const runDocumentFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
  await waitForMessage(page, "Tabula.md document is ready.");
  await page.getByRole("button", { name: "Open in Tabula" }).waitFor({ state: "visible" });
  await assertInlineDocumentPresentation(page, "inline document");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Inline" }).waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "Outline" }).waitFor({ state: "visible" });

  const markdown = [
    "# Flow Smoke",
    "",
    "Edited from browser smoke.",
    "",
    "## Long Selection",
    "",
    `Start ${"large selection body ".repeat(240)}End`,
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

  await page.locator("#markdownEditor").evaluate((element) => {
    const text = element.value;
    const start = text.indexOf("Start ");
    const end = text.indexOf("End", start) + "End".length;
    element.focus();
    element.setSelectionRange(start, end);
  });
  await page.getByRole("button", { name: "Send Selection" }).click();
  await waitForMessage(page, "Selection sent to the model context.");

  const shareMarkdown = `${markdown}\n\n## Shared Update\n\nReady for encrypted handoff.`;
  await page.locator("#markdownEditor").fill(shareMarkdown);
  await waitForMessage(page, "Document has unsaved changes.");
  await page.getByRole("button", { name: "Share" }).click();
  await waitForMessage(page, "Encrypted share link sent to the model context.");
  assert.equal(
    await page.getByRole("button", { name: "Send Changes" }).isDisabled(),
    true,
    "share should include unsent edits and clear the model context baseline",
  );

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

  assert(
    !events.modelContexts.some((payload) => payload?.structuredContent?.tabulaComment),
    "document flow should not expose default comment marker context handoff",
  );

  const selection = events.modelContexts.find((payload) => payload?.structuredContent?.tabulaSelection);
  assert(selection, "document flow should send selected text context");
  assert.equal(selection.structuredContent.tabulaSelection.truncated, true);
  assert(
    selection.structuredContent.tabulaSelection.originalLength >
      selection.structuredContent.tabulaSelection.excerptLength,
    "selection context should report truncation lengths",
  );
  assert(
    selection.structuredContent.tabulaSelection.text.includes("[truncated selection]"),
    "selection context should include an explicit truncation marker",
  );
  assert(
    !JSON.stringify(selection).includes("large selection body ".repeat(120)),
    "selection context should not include the full selected text",
  );

  const share = events.modelContexts.find((payload) => payload?.structuredContent?.tabulaShare);
  assert(share, "document flow should send encrypted share context");
  assert.equal(share.structuredContent.tabulaShare.encrypted, true);
  assert.equal(share.structuredContent.tabulaShare.linkKind, "json-snapshot");
  assert.match(share.structuredContent.tabulaShare.shareUrl, /#json=[^,]+,/);
  assert(
    share.structuredContent.tabulaDocumentChange,
    "share context should include any unsent compact document change summary",
  );
  assert.equal(share.structuredContent.tabulaDocumentChange.summary.changed, true);
  assert(
    share.structuredContent.tabulaDocumentChange.summary.currentExcerpt.includes("Shared Update"),
    "share change summary should describe the unsent edit",
  );
  assert(
    !JSON.stringify(share).includes(`${shareMarkdown}\n`),
    "share change context should not include the full Markdown body",
  );

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runMobileLayoutFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser, mobileViewport);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
  await waitForMessage(page, "Tabula.md document is ready.");

  await assertInlineDocumentPresentation(page, "mobile inline document");
  await assertNoHorizontalOverflow(page, "mobile initial document layout");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Inline" }).waitFor({ state: "visible" });

  await page.locator("#titleInput").fill("Mobile smoke title");
  await page.locator("#markdownEditor").fill(
    [
      "# Mobile Smoke",
      "",
      "This verifies the Tabula.md MCP App controls stay usable on narrow hosts.",
      "",
      "## Preview",
      "",
      "- Editor",
      "- Split",
      "- Context",
    ].join("\n"),
  );
  await waitForMessage(page, "Document has unsaved changes.");
  await assertNoHorizontalOverflow(page, "mobile edited document layout");

  for (const viewMode of ["Preview", "Editor", "Split"]) {
    await page.getByRole("button", { name: viewMode }).click();
    await assertNoHorizontalOverflow(page, `mobile ${viewMode.toLowerCase()} view layout`);
  }

  await assertNoHorizontalOverflow(page, "mobile fullscreen layout");

  const events = await getDevEvents(page);
  assert(
    events.displayModes.some((event) => event?.mode === "fullscreen"),
    "mobile flow should exercise fullscreen display mode",
  );

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runRoomFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1&fixture=room`);
  await waitForMessage(page, "Tabula.md content is current.");
  await assertInlineDocumentPresentation(page, "inline room document");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Inline" }).waitFor({ state: "visible" });

  await page.getByRole("button", { name: "Refresh" }).click();
  await waitForMessage(page, "Tabula.md content is current.");

  const isReadOnly = await page.locator("#markdownEditor").evaluate((element) => element.readOnly);
  assert.equal(isReadOnly, true, "room fixture must open in read-only mode");

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
    await runMobileLayoutFlow(baseUrl, browser);
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
