import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { createServer } from "vite";

const host = "127.0.0.1";
const desktopViewport = { width: 1280, height: 720 };
const mobileViewport = { width: 390, height: 844 };

const getDevEvents = (page) =>
  page.evaluate(() => ({
    toolCalls: window.__TABULA_DEV_TOOL_CALLS__ || [],
    openLinks: window.__TABULA_DEV_OPEN_LINKS__ || [],
  }));

const installDevEventCapture = async (page) => {
  await page.addInitScript(() => {
    window.__TABULA_DEV_TOOL_CALLS__ = [];
    window.__TABULA_DEV_OPEN_LINKS__ = [];
    window.addEventListener("tabula-dev:tool-call", (event) => {
      window.__TABULA_DEV_TOOL_CALLS__.push(event.detail);
    });
    window.addEventListener("tabula-dev:open-link", (event) => {
      window.__TABULA_DEV_OPEN_LINKS__.push(event.detail);
    });
  });
};

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

const assertNoPageErrors = (consoleErrors, pageErrors) => {
  assert.deepEqual(pageErrors, [], "dev harness should not throw page errors");
  assert.deepEqual(consoleErrors, [], "dev harness should not log browser console errors");
};

const assertNoHorizontalOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    rootScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    cardScrollWidth: document.querySelector(".handoff-card")?.scrollWidth ?? 0,
  }));
  const tolerance = 2;
  assert(overflow.rootScrollWidth <= overflow.viewportWidth + tolerance, `${label} root should not overflow horizontally`);
  assert(overflow.bodyScrollWidth <= overflow.viewportWidth + tolerance, `${label} body should not overflow horizontally`);
  assert(overflow.cardScrollWidth <= overflow.viewportWidth + tolerance, `${label} card should not overflow horizontally`);
};

const assertHandoffPresentation = async (page, label) => {
  await page.locator(".handoff-card").waitFor({ state: "visible" });
  assert.equal(await page.locator("textarea").count(), 0, `${label} must not render a Markdown editor`);
  assert.equal(await page.locator("[data-tabula-document-workbench]").count(), 0, `${label} must not embed the Tabula workbench`);
  assert.equal(await page.getByRole("button", { name: /^Edit$/ }).count(), 0, `${label} must not offer an editing mode`);
  assert.equal(await page.locator(".handoff-summary").count(), 0, `${label} must not render a redundant summary block`);
  const card = await page.locator(".handoff-card").boundingBox();
  assert(card && card.height <= 72, `${label} should remain a compact receipt, got ${card?.height ?? 0}px`);
};

const runCopyFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
  await page.getByText("Encrypted copy", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("3 files", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open copy" }).waitFor({ state: "visible" });
  await assertHandoffPresentation(page, "copy handoff");

  await page.getByRole("button", { name: "Open copy" }).click();
  await page.locator("#message", { hasText: "Opened" }).waitFor({ state: "visible" });
  const events = await getDevEvents(page);
  assert.equal(events.toolCalls.length, 0, "copy handoff must not call another server tool");
  assert(events.openLinks.some((request) => String(request?.url).includes("#json=")), "copy handoff should open the prepared #json link");

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runSessionFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1&fixture=session`);
  await page.getByText("Live session", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("2 files", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open session" }).waitFor({ state: "visible" });
  await assertHandoffPresentation(page, "session handoff");

  await page.getByRole("button", { name: "Open session" }).click();
  await page.locator("#message", { hasText: "Opened" }).waitFor({ state: "visible" });
  const events = await getDevEvents(page);
  assert.equal(events.toolCalls.length, 0, "session handoff must not call another server tool");
  assert(events.openLinks.some((request) => String(request?.url).includes("#room=")), "session handoff should open the prepared #room link");

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runDeniedLinkFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1&fixture=session&open-links=deny`);
  await page.getByRole("button", { name: "Open session" }).click();
  const message = page.locator("#message");
  await message.filter({ hasText: "Not approved" }).waitFor({ state: "visible" });
  assert.equal(await message.getAttribute("data-tone"), "warning");
  assert.equal((await message.textContent())?.includes("blocked by this MCP host"), false);
  assert.equal((await message.textContent())?.startsWith("{"), false, "host denial must not render raw JSON");
  assert.equal((await getDevEvents(page)).toolCalls.length, 0);
  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runUnsupportedLinkFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1&open-links=unsupported`);
  const button = page.getByRole("button", { name: "Open copy" });
  await button.waitFor({ state: "visible" });
  assert.equal(await button.isDisabled(), true);
  await page.locator("#message", { hasText: "Cannot open links" }).waitFor({ state: "visible" });
  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runMobileFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser, mobileViewport);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
  await page.getByRole("button", { name: "Open copy" }).waitFor({ state: "visible" });
  await assertHandoffPresentation(page, "mobile handoff");
  await assertNoHorizontalOverflow(page, "mobile handoff");
  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const main = async () => {
  const server = await createServer({
    configFile: "vite.config.dev.mjs",
    server: { host, port: 0, strictPort: false },
    logLevel: "silent",
  });

  let browser;
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
    assert(baseUrl, "Vite dev server did not expose a local URL");
    browser = await chromium.launch({ headless: true });
    await runCopyFlow(baseUrl, browser);
    await runSessionFlow(baseUrl, browser);
    await runDeniedLinkFlow(baseUrl, browser);
    await runUnsupportedLinkFlow(baseUrl, browser);
    await runMobileFlow(baseUrl, browser);
  } catch (error) {
    if (String(error?.message || error).includes("Executable doesn't exist")) {
      throw new Error("Playwright Chromium is not installed. Run `npx playwright install chromium`.");
    }
    throw error;
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log("MCP App handoff browser flow passed");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
