import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "assets", "directory");
const host = "127.0.0.1";
const viewport = { width: 1440, height: 1024 };

const waitForStableCard = async (page, message) => {
  await page.locator("#message", { hasText: message }).waitFor({ state: "attached" });
  await page.locator(".session-card").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
};

const capture = async (page, filename) => {
  await page.screenshot({
    path: path.join(outputDir, filename),
    animations: "disabled",
    caret: "hide",
  });
};

const main = async () => {
  const server = await createServer({
    configFile: path.join(rootDir, "vite.config.dev.mjs"),
    server: { host, port: 0, strictPort: false },
    logLevel: "silent",
  });

  let browser;
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
    assert(baseUrl, "Vite dev server did not expose a local URL");
    await mkdir(outputDir, { recursive: true });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport, colorScheme: "light", reducedMotion: "reduce" });

    await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1`);
    await waitForStableCard(page, "Tabula.md draft is ready.");
    await capture(page, "local-draft-card.png");

    await page.getByRole("button", { name: "Start session" }).click();
    await waitForStableCard(page, "Shared session is ready. Claude is connected to it.");
    await page.getByRole("button", { name: "Open session" }).waitFor({ state: "visible" });
    await capture(page, "live-session-card.png");

    await page.goto(`${baseUrl}/index-dev.html?tabula-dev=1&fixture=room`);
    await waitForStableCard(page, "Tabula.md session is ready.");
    await capture(page, "connected-session-card.png");

    await Promise.all([
      rm(path.join(outputDir, "document-preview.png"), { force: true }),
      rm(path.join(outputDir, "document-editor.png"), { force: true }),
      rm(path.join(outputDir, "room-context.png"), { force: true }),
    ]);
  } catch (error) {
    if (String(error?.message || error).includes("Executable doesn't exist")) {
      throw new Error("Playwright Chromium is not installed. Run `npx playwright install chromium`.");
    }
    throw error;
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log("Directory screenshots captured from the current Session Card");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
