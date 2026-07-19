import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";

const releaseManifest = JSON.parse(await readFile("release-manifest.json", "utf8"));
const mcpUrl = new URL(releaseManifest.worker.mcpPath, releaseManifest.worker.origin);
const marker = `production-release-${randomUUID()}`;
const initialContent = `# Production release smoke\n\n${marker}\n`;
const updatedContent = `${initialContent}\nVerified through a second production MCP client.\n`;

const callTool = async (client, name, args) => {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch {
    throw new Error(`Production ${name} transport call failed.`);
  }
  assert.notEqual(result.isError, true, `Production ${name} returned a tool error.`);
  assert(result.structuredContent, `Production ${name} did not return structured content.`);
  return result.structuredContent;
};

const connectClient = async (name) => {
  const client = new Client({ name, version: releaseManifest.releaseVersion });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
  return client;
};

const leaveQuietly = async (client, sessionId) => {
  if (!client || !sessionId) return;
  try {
    await client.callTool({ name: "leave_session", arguments: { sessionId } });
  } catch {
    // The release smoke reports the primary failure while still attempting all cleanup.
  }
};

const readUntil = async (client, sessionId, expectedContent) => {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const file = await callTool(client, "read_file", { sessionId, path: "README.md" });
    if (file.content === expectedContent) return file;
    if (attempt < 20) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Production Room did not converge across MCP clients.");
};

const editorText = (page) => page.$$eval(
  ".cm-content .cm-line",
  (lines) => lines.map((line) => line.textContent ?? "").join("\n"),
);

const openCopyInProduction = async (copyUrl, expectedText) => {
  const parsed = new URL(copyUrl);
  const [, copyKey = ""] = parsed.hash.replace(/^#json=/, "").split(",");
  assert(copyKey, "Production Copy URL did not include a client-side decryption key.");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let leakedKey = false;
  page.on("request", (request) => {
    if (request.url().includes(copyKey)) leakedKey = true;
  });

  try {
    await page.goto(parsed.origin, { waitUntil: "domcontentloaded" });
    const newDocument = page.getByRole("button", { name: "New document", exact: true });
    await newDocument.first().waitFor();
    await newDocument.first().click();
    await page.locator(".cm-content").waitFor();
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, parsed.hash);

    const modal = page.locator(".share-modal");
    const deadline = Date.now() + 20_000;
    let opened = false;
    while (Date.now() < deadline) {
      const content = await editorText(page).catch(() => "");
      if (content.includes(expectedText)) {
        opened = true;
        break;
      }
      if (await modal.locator(".json-import-copy").count()) {
        await modal.locator("button.share-modal-primary").click();
        await modal.waitFor({ state: "detached" });
      }
      await page.waitForTimeout(100);
    }

    if (!opened) {
      opened = (await editorText(page).catch(() => "")).includes(expectedText);
    }
    assert(opened, "Production Tabula.md did not open the exported Copy.");
    assert.equal(leakedKey, false, "Production Tabula.md sent the Copy decryption key in a network request.");
  } finally {
    await context.close();
    await browser.close();
  }
};

let owner;
let peer;
let ownerSessionId;
let peerSessionId;

try {
  owner = await connectClient("tabula-production-release-owner");
  peer = await connectClient("tabula-production-release-peer");

  const ownerTools = await owner.listTools();
  for (const name of ["start_session", "join_room", "read_file", "write_file", "export_copy", "import_copy", "leave_session"]) {
    assert(ownerTools.tools.some((tool) => tool.name === name), `Production MCP did not expose ${name}.`);
  }

  const started = await callTool(owner, "start_session", {
    title: "Production release smoke",
    files: [{ path: "README.md", content: initialContent }],
  });
  ownerSessionId = started.sessionId;
  assert.equal(started.ready, true, "Production Start Session did not become ready.");
  assert.equal(started.canWrite, true, "Production Start Session was not writable.");

  const joined = await callTool(peer, "join_room", { roomUrl: started.sessionUrl });
  peerSessionId = joined.sessionId;
  assert.equal(joined.ready, true, "Production Join Room did not become ready.");
  assert.equal(joined.canWrite, true, "Production Join Room was not writable.");

  const peerRead = await callTool(peer, "read_file", { sessionId: peerSessionId, path: "README.md" });
  assert.equal(peerRead.content, initialContent, "The second production MCP client read different Room content.");

  await callTool(peer, "write_file", {
    sessionId: peerSessionId,
    path: "README.md",
    content: updatedContent,
    expectedRevision: peerRead.revision,
  });
  await readUntil(owner, ownerSessionId, updatedContent);

  const reused = await callTool(peer, "join_room", { roomUrl: started.sessionUrl });
  assert.equal(reused.sessionId, peerSessionId, "Repeated production Join Room did not reuse the session.");
  assert.equal(reused.reused, true, "Repeated production Join Room did not report reuse.");

  const exported = await callTool(peer, "export_copy", { sessionId: peerSessionId });
  const imported = await callTool(peer, "import_copy", { copyUrl: exported.copyUrl });
  assert.equal(imported.fileCount, 1, "Production Copy did not preserve its file count.");
  assert.equal(imported.files?.[0]?.content, updatedContent, "Production Copy import changed the Markdown content.");
  await openCopyInProduction(exported.copyUrl, marker);
} finally {
  await leaveQuietly(peer, peerSessionId);
  await leaveQuietly(owner, ownerSessionId);
  await peer?.close().catch(() => {});
  await owner?.close().catch(() => {});
}

console.log("Production MCP collaboration, Copy round trip, browser open, and cleanup verified.");
