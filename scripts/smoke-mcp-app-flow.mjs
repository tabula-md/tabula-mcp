import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { createServer } from "vite";

const host = "127.0.0.1";
const desktopViewport = { width: 1280, height: 720 };
const mobileViewport = { width: 390, height: 844 };

const waitForMessage = async (page, text) => {
  await page.locator("#message", { hasText: text }).waitFor({ state: "attached" });
};

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
    cardScrollWidth: document.querySelector(".session-card")?.scrollWidth ?? 0,
  }));
  const tolerance = 2;
  assert(overflow.rootScrollWidth <= overflow.viewportWidth + tolerance, `${label} root should not overflow horizontally`);
  assert(overflow.bodyScrollWidth <= overflow.viewportWidth + tolerance, `${label} body should not overflow horizontally`);
  assert(overflow.cardScrollWidth <= overflow.viewportWidth + tolerance, `${label} card should not overflow horizontally`);
};

const assertSessionCardPresentation = async (page, label) => {
  await page.locator(".session-card").waitFor({ state: "visible" });
  assert.equal(await page.locator("textarea").count(), 0, `${label} must not render a second Markdown editor`);
  assert.equal(await page.locator("[data-tabula-document-workbench]").count(), 0, `${label} must not embed the Tabula workbench`);
  assert.equal(await page.getByRole("button", { name: "Edit" }).count(), 0, `${label} must not offer a second editing mode`);
};

const runDocumentFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
  await waitForMessage(page, "Tabula.md draft is ready.");
  await page.getByRole("heading", { name: "Launch Brief" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open a copy" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Start session" }).waitFor({ state: "visible" });
  await assertSessionCardPresentation(page, "document handoff");

  await page.getByRole("button", { name: "Open a copy" }).click();
  await waitForMessage(page, "Opened a Tabula.md copy.");
  let events = await getDevEvents(page);
  assert(events.toolCalls.some((call) => call?.name === "tabula_share_document"), "Open a copy should create an encrypted JSON snapshot");
  assert(events.openLinks.some((request) => String(request?.url).includes("#json=")), "Open a copy should open the Tabula.md snapshot link");

  await page.getByRole("button", { name: "Start session" }).click();
  await waitForMessage(page, "Tabula.md session is ready.");
  await page.getByRole("button", { name: "Open session" }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Open a copy" }).isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "Start session" }).isVisible(), false);

  await page.getByRole("button", { name: "Open session" }).click();
  events = await getDevEvents(page);
  assert(events.toolCalls.some((call) => call?.name === "tabula_app_start_room_from_document"), "Start session should create a Room from the local draft");
  assert(events.openLinks.some((request) => String(request?.url).includes("#room=")), "Open session should open the encrypted Room link");

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runMobileFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser, mobileViewport);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
  await waitForMessage(page, "Tabula.md draft is ready.");
  await assertSessionCardPresentation(page, "mobile document handoff");
  await assertNoHorizontalOverflow(page, "mobile document handoff");

  await page.getByRole("button", { name: "Start session" }).click();
  await page.getByRole("button", { name: "Open session" }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, "mobile session handoff");

  assertNoPageErrors(consoleErrors, pageErrors);
  await page.close();
};

const runRoomFlow = async (baseUrl, browser) => {
  const { page, consoleErrors, pageErrors } = await createPage(browser);
  await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1&fixture=room`);
  await waitForMessage(page, "Tabula.md session is ready.");
  await page.getByRole("heading", { name: "Research Review" }).waitFor({ state: "visible" });
  await page.getByText("This encrypted session is ready in Tabula.md.").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open session" }).waitFor({ state: "visible" });
  await assertSessionCardPresentation(page, "room handoff");

  await page.getByRole("button", { name: "Open session" }).click();
  assert(
    (await getDevEvents(page)).openLinks.some((request) => String(request?.url).includes("#room=")),
    "room handoff should open the encrypted Room link",
  );

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
    await runDocumentFlow(baseUrl, browser);
    await runMobileFlow(baseUrl, browser);
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
