import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createTabulaMcpServer, resolveWriteEnabled } from "./index.js";
import { roomViewAppResourceUri } from "./app-resource.js";

const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const withClient = async <T>(
  writeEnabled: boolean,
  callback: (client: Client) => Promise<T>,
  options: { mcpApps?: boolean } = {},
) => {
  const { server, registry } = createTabulaMcpServer({ writeEnabled });
  const client = new Client(
    { name: "tabula-mcp-test", version: "0.0.0" },
    options.mcpApps ? { capabilities: uiCapabilities } : undefined,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await callback(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    registry.clear();
  }
};

const listTools = async (writeEnabled: boolean, options: { mcpApps?: boolean } = {}) =>
  withClient(writeEnabled, (client) => client.listTools(), options);

describe("write access configuration", () => {
  it("defaults to read-only", () => {
    expect(resolveWriteEnabled({ env: {}, argv: [] })).toBe(false);
  });

  it("enables write mode with an environment variable", () => {
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "1" }, argv: [] })).toBe(true);
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "true" }, argv: [] })).toBe(true);
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "YES" }, argv: [] })).toBe(true);
  });

  it("enables write mode with a CLI flag and lets --read-only override it", () => {
    expect(resolveWriteEnabled({ env: {}, argv: ["--enable-write"] })).toBe(true);
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "1" }, argv: ["--read-only"] })).toBe(false);
  });
});

describe("MCP tool registration", () => {
  it("does not expose the patch tool or writeAccess input in read-only mode", async () => {
    const tools = await listTools(false);
    const toolNames = tools.tools.map((tool) => tool.name);
    const connectTool = tools.tools.find((tool) => tool.name === "tabula_connect_room");

    expect(toolNames).not.toContain("tabula_apply_text_patches");
    expect(connectTool?.inputSchema.properties).not.toHaveProperty("writeAccess");
    expect(connectTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("exposes the patch tool only when server-level write mode is enabled", async () => {
    const tools = await listTools(true);
    const patchTool = tools.tools.find((tool) => tool.name === "tabula_apply_text_patches");

    expect(patchTool).toBeDefined();
    expect(patchTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it("does not expose MCP App tools to clients that do not advertise MCP Apps support", async () => {
    const tools = await listTools(false);
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).not.toContain("tabula_open_room_view");
    expect(toolNames).not.toContain("tabula_app_room_snapshot");
  });

  it("registers a Tabula Room View MCP App for MCP Apps clients and keeps app snapshot reads app-only", async () => {
    const tools = await listTools(false, { mcpApps: true });
    const roomViewTool = tools.tools.find((tool) => tool.name === "tabula_open_room_view");
    const appSnapshotTool = tools.tools.find((tool) => tool.name === "tabula_app_room_snapshot");

    expect(roomViewTool?._meta).toMatchObject({
      ui: {
        resourceUri: roomViewAppResourceUri,
      },
      "ui/resourceUri": roomViewAppResourceUri,
    });
    expect(roomViewTool?.annotations?.readOnlyHint).toBe(true);
    expect(appSnapshotTool?._meta).toMatchObject({
      ui: {
        visibility: ["app"],
      },
    });
  });

  it("serves the Tabula Room View resource as an MCP App HTML resource", async () => {
    await withClient(false, async (client) => {
      const resources = await client.listResources();
      expect(resources.resources.some((resource) => resource.uri === roomViewAppResourceUri)).toBe(true);

      const resource = await client.readResource({ uri: roomViewAppResourceUri });
      expect(resource.contents[0]).toMatchObject({
        uri: roomViewAppResourceUri,
        mimeType: "text/html;profile=mcp-app",
      });
      expect("text" in resource.contents[0] ? resource.contents[0].text : "").toContain("Tabula.md Room View");
    });
  });
});
