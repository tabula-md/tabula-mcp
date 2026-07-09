import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tabulaDocumentAppResourceUri } from "../src/app/types.js";
import { MemoryDocumentStore } from "../src/documents/store.js";
import { createTabulaMcpServer, resolveWriteEnabled } from "../src/index.js";

const originalFetch = globalThis.fetch;

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
  const { server, registry, documents } = createTabulaMcpServer({
    writeEnabled,
    documentStore: new MemoryDocumentStore(),
  });
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
    documents.clear();
  }
};

const listTools = async (writeEnabled: boolean, options: { mcpApps?: boolean } = {}) =>
  withClient(writeEnabled, (client) => client.listTools(), options);

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

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
    const listSessionsTool = tools.tools.find((tool) => tool.name === "tabula_list_sessions");
    const statusTool = tools.tools.find((tool) => tool.name === "tabula_room_status");
    const readMarkdownTool = tools.tools.find((tool) => tool.name === "tabula_read_markdown");
    const outlineTool = tools.tools.find((tool) => tool.name === "tabula_get_outline");
    const readWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_read_workspace");
    const readWorkspaceDocumentTool = tools.tools.find((tool) => tool.name === "tabula_read_workspace_document");
    const proposeWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_propose_workspace_changes");
    const proposeTool = tools.tools.find((tool) => tool.name === "tabula_propose_text_patches");
    const setPresenceTool = tools.tools.find((tool) => tool.name === "tabula_set_presence");
    const waitTool = tools.tools.find((tool) => tool.name === "tabula_wait_for_changes");
    const disconnectTool = tools.tools.find((tool) => tool.name === "tabula_disconnect_room");

    expect(toolNames).toContain("tabula_read_me");
    expect(toolNames).toContain("tabula_propose_text_patches");
    expect(toolNames).toContain("tabula_read_workspace");
    expect(toolNames).toContain("tabula_read_workspace_document");
    expect(toolNames).toContain("tabula_propose_workspace_changes");
    expect(toolNames).not.toContain("tabula_apply_text_patches");
    expect(connectTool?.inputSchema.properties).not.toHaveProperty("writeAccess");
    expect(connectTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        sessionId: expect.objectContaining({ type: "string" }),
        recoveryStatus: expect.objectContaining({ const: "relay-only" }),
        actor: expect.objectContaining({ type: "object" }),
        capabilities: expect.objectContaining({ type: "array" }),
        hydrationStatus: expect.objectContaining({ enum: ["waiting-for-peer-state", "ready"] }),
        stateReceived: expect.objectContaining({ type: "boolean" }),
        pendingProposalCount: expect.objectContaining({ type: "integer" }),
        note: expect.objectContaining({ type: "string" }),
      },
    });
    expect(listSessionsTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        sessions: expect.objectContaining({ type: "array" }),
      },
    });
    expect(statusTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        roomServerUrl: expect.objectContaining({ type: "string" }),
        actor: expect.objectContaining({ type: "object" }),
        capabilities: expect.objectContaining({ type: "array" }),
        hydrationStatus: expect.objectContaining({ enum: ["waiting-for-peer-state", "ready"] }),
        stateReceived: expect.objectContaining({ type: "boolean" }),
        collaborators: expect.objectContaining({ type: "array" }),
        pendingProposalCount: expect.objectContaining({ type: "integer" }),
        pendingWorkspaceProposalCount: expect.objectContaining({ type: "integer" }),
      },
    });
    expect(readMarkdownTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        markdown: expect.objectContaining({ type: "string" }),
        sha256: expect.objectContaining({ type: "string" }),
        hydrationStatus: expect.objectContaining({ enum: ["waiting-for-peer-state", "ready"] }),
        stateReceived: expect.objectContaining({ type: "boolean" }),
      },
    });
    expect(outlineTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        outline: expect.objectContaining({ type: "array" }),
      },
    });
    expect(readWorkspaceTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        workspace: expect.objectContaining({ anyOf: expect.any(Array) }),
        documents: expect.objectContaining({ type: "array" }),
        cachedDocumentCount: expect.objectContaining({ type: "integer" }),
      },
    });
    expect(readWorkspaceDocumentTool?.inputSchema.properties).toHaveProperty("documentId");
    expect(readWorkspaceDocumentTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        documentId: expect.objectContaining({ type: "string" }),
        markdown: expect.objectContaining({ type: "string" }),
        sha256: expect.objectContaining({ type: "string" }),
      },
    });
    expect(proposeWorkspaceTool?.inputSchema.properties).toHaveProperty("changes");
    expect(proposeWorkspaceTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        emitted: expect.objectContaining({ type: "boolean" }),
        proposal: expect.objectContaining({ type: "object" }),
      },
    });
    expect(proposeTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        emitted: expect.objectContaining({ type: "boolean" }),
        proposal: expect.objectContaining({ type: "object" }),
      },
    });
    expect(setPresenceTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        identity: expect.objectContaining({ type: "object" }),
      },
    });
    expect(waitTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        changed: expect.objectContaining({ type: "boolean" }),
        markdown: expect.objectContaining({ type: "string" }),
      },
    });
    expect(disconnectTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        disconnectedSessionId: expect.objectContaining({ type: "string" }),
      },
    });
    expect(connectTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("exposes the patch tool only when server-level write mode is enabled", async () => {
    const tools = await listTools(true);
    const proposeTool = tools.tools.find((tool) => tool.name === "tabula_propose_text_patches");
    const patchTool = tools.tools.find((tool) => tool.name === "tabula_apply_text_patches");

    expect(proposeTool).toBeDefined();
    expect(patchTool).toBeDefined();
    expect(patchTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(patchTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        changed: expect.objectContaining({ type: "boolean" }),
        previousSha256: expect.objectContaining({ type: "string" }),
        sha256: expect.objectContaining({ type: "string" }),
      },
    });
  });

  it("returns model guidance through tabula_read_me without requiring MCP Apps", async () => {
    await withClient(false, async (client) => {
      const tools = await client.listTools();
      const readMeTool = tools.tools.find((tool) => tool.name === "tabula_read_me");
      expect(readMeTool?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          readMe: expect.objectContaining({ type: "object" }),
        },
      });

      const result = await client.callTool({
        name: "tabula_read_me",
        arguments: {
          topic: "sharing",
        },
      });
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const structured = result.structuredContent as {
        readMe: {
          topic: string;
          nextActions: string[];
          securityRules: string[];
        };
      };

      expect(text).toContain("Tabula.md MCP read_me (sharing)");
      expect(text).toContain("bearer secret");
      expect(structured.readMe.topic).toBe("sharing");
      expect(structured.readMe.nextActions.length).toBeGreaterThan(0);
      expect(structured.readMe.securityRules.join("\n")).toContain("#room");
    });
  });

  it("does not expose MCP App tools to clients that do not advertise MCP Apps support", async () => {
    const tools = await listTools(false);
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).not.toContain("tabula_open_room_view");
    expect(toolNames).not.toContain("tabula_create_document");
    expect(toolNames).not.toContain("tabula_list_documents");
    expect(toolNames).not.toContain("tabula_open_document");
    expect(toolNames).not.toContain("tabula_share_document");
    expect(toolNames).not.toContain("tabula_app_room_snapshot");
    expect(toolNames).not.toContain("tabula_app_document_snapshot");
    expect(toolNames).not.toContain("tabula_app_save_document");
  });

  it("registers a Tabula Document MCP App for MCP Apps clients and keeps app helpers app-only", async () => {
    const tools = await listTools(false, { mcpApps: true });
    const createDocumentTool = tools.tools.find((tool) => tool.name === "tabula_create_document");
    const listDocumentsTool = tools.tools.find((tool) => tool.name === "tabula_list_documents");
    const openDocumentTool = tools.tools.find((tool) => tool.name === "tabula_open_document");
    const roomViewTool = tools.tools.find((tool) => tool.name === "tabula_open_room_view");
    const shareDocumentTool = tools.tools.find((tool) => tool.name === "tabula_share_document");
    const appSnapshotTool = tools.tools.find((tool) => tool.name === "tabula_app_room_snapshot");
    const appDocumentSnapshotTool = tools.tools.find((tool) => tool.name === "tabula_app_document_snapshot");
    const appSaveDocumentTool = tools.tools.find((tool) => tool.name === "tabula_app_save_document");

    expect(createDocumentTool?._meta).toMatchObject({
      ui: {
        resourceUri: tabulaDocumentAppResourceUri,
      },
      "ui/resourceUri": tabulaDocumentAppResourceUri,
    });
    expect(createDocumentTool?.annotations?.readOnlyHint).toBe(false);
    expect(listDocumentsTool?.annotations?.readOnlyHint).toBe(true);
    expect(openDocumentTool?._meta).toMatchObject({
      ui: {
        resourceUri: tabulaDocumentAppResourceUri,
      },
      "ui/resourceUri": tabulaDocumentAppResourceUri,
    });
    expect(openDocumentTool?.annotations?.readOnlyHint).toBe(true);
    expect(roomViewTool?._meta).toMatchObject({
      ui: {
        resourceUri: tabulaDocumentAppResourceUri,
      },
      "ui/resourceUri": tabulaDocumentAppResourceUri,
    });
    expect(roomViewTool?.annotations?.readOnlyHint).toBe(true);
    expect(shareDocumentTool?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
    expect(appSnapshotTool?._meta).toMatchObject({
      ui: {
        visibility: ["app"],
      },
    });
    expect(appDocumentSnapshotTool?._meta).toMatchObject({
      ui: {
        visibility: ["app"],
      },
    });
    expect(appSaveDocumentTool?._meta).toMatchObject({
      ui: {
        visibility: ["app"],
      },
    });
    expect(createDocumentTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        document: expect.objectContaining({ type: "object" }),
        markdown: expect.objectContaining({ type: "string" }),
        outline: expect.objectContaining({ type: "array" }),
      },
    });
    expect(listDocumentsTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        documents: expect.objectContaining({ type: "array" }),
      },
    });
    expect(shareDocumentTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        share: expect.objectContaining({ type: "object" }),
      },
    });
  });

  it("serves the Tabula Document resource as an MCP App HTML resource", async () => {
    await withClient(false, async (client) => {
      const resources = await client.listResources();
      expect(resources.resources.some((resource) => resource.uri === tabulaDocumentAppResourceUri)).toBe(true);

      const resource = await client.readResource({ uri: tabulaDocumentAppResourceUri });
      expect(resource.contents[0]).toMatchObject({
        uri: tabulaDocumentAppResourceUri,
        mimeType: "text/html;profile=mcp-app",
      });
      expect("text" in resource.contents[0] ? resource.contents[0].text : "").toContain("Tabula.md Document");
    });
  });

  it("creates, snapshots, and saves local Tabula documents through MCP App tools", async () => {
    await withClient(
      false,
      async (client) => {
        const createResult = await client.callTool({
          name: "tabula_create_document",
          arguments: {
            title: "Draft",
            markdown: "# Draft\n\nBody",
          },
        });
        const created = createResult.structuredContent as {
          document: { documentId: string; title: string; sha256: string; textLength: number; outlineCount: number };
          markdown: string;
          outline: unknown[];
        };

        expect(created.document.title).toBe("Draft");
        expect(created.document.textLength).toBe("# Draft\n\nBody".length);
        expect(created.document.outlineCount).toBe(1);
        expect(created.markdown).toBe("# Draft\n\nBody");

        const snapshotResult = await client.callTool({
          name: "tabula_app_document_snapshot",
          arguments: { documentId: created.document.documentId },
        });
        const snapshot = snapshotResult.structuredContent as { document: { sha256: string }; markdown: string };

        expect(snapshot.document.sha256).toBe(created.document.sha256);
        expect(snapshot.markdown).toBe("# Draft\n\nBody");

        const saveResult = await client.callTool({
          name: "tabula_app_save_document",
          arguments: {
            documentId: created.document.documentId,
            markdown: "# Draft\n\nUpdated body",
          },
        });
        const saved = saveResult.structuredContent as {
          document: { sha256: string; textLength: number };
          markdown: string;
        };

        expect(saved.markdown).toBe("# Draft\n\nUpdated body");
        expect(saved.document.sha256).not.toBe(created.document.sha256);
        expect(saved.document.textLength).toBe("# Draft\n\nUpdated body".length);

        const listResult = await client.callTool({
          name: "tabula_list_documents",
          arguments: {},
        });
        const listed = listResult.structuredContent as {
          documents: Array<{ documentId: string; title: string; textLength: number }>;
        };

        expect(listed.documents).toEqual([
          expect.objectContaining({
            documentId: created.document.documentId,
            title: "Draft",
            textLength: "# Draft\n\nUpdated body".length,
          }),
        ]);

        const openResult = await client.callTool({
          name: "tabula_open_document",
          arguments: { documentId: created.document.documentId },
        });
        const opened = openResult.structuredContent as {
          document: { documentId: string; sha256: string };
          markdown: string;
        };

        expect(opened.document.documentId).toBe(created.document.documentId);
        expect(opened.document.sha256).toBe(saved.document.sha256);
        expect(opened.markdown).toBe("# Draft\n\nUpdated body");
      },
      { mcpApps: true },
    );
  });

  it("exports local Tabula documents as encrypted JSON snapshot links", async () => {
    const snapshotId = "snapshot_123";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await withClient(
      false,
      async (client) => {
        const createResult = await client.callTool({
          name: "tabula_create_document",
          arguments: {
            title: "Share Draft",
            markdown: "# Share Draft\n\nKeep plaintext local",
          },
        });
        const created = createResult.structuredContent as {
          document: { documentId: string };
        };

        const shareResult = await client.callTool({
          name: "tabula_share_document",
          arguments: { documentId: created.document.documentId },
        });
        const shared = shareResult.structuredContent as {
          share: {
            title: string;
            linkKind: string;
            snapshotId: string;
            shareUrl: string;
            jsonServerUrl: string;
            snapshotUrl: string;
            encrypted: boolean;
            secret: boolean;
            keyLocation: string;
          };
        };

        expect(shared.share).toMatchObject({
          title: "Share Draft",
          linkKind: "json-snapshot",
          snapshotId,
          jsonServerUrl: "https://json.tabula.md",
          snapshotUrl: `https://json.tabula.md/api/v2/${snapshotId}`,
          encrypted: true,
          secret: true,
          keyLocation: "url-fragment",
        });
        expect(shared.share.shareUrl).toMatch(new RegExp(`^https://tabula\\.md/#json=${snapshotId},`));
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(String(url)).toBe("https://json.tabula.md/api/v2/post/");

        const body = Buffer.from((init as RequestInit | undefined)?.body as ArrayBuffer).toString("utf8");
        const snapshotKey = new URL(shared.share.shareUrl).hash.replace(new RegExp(`^#json=${snapshotId},`), "");
        expect(body).not.toContain("Keep plaintext local");
        expect(body).not.toContain(snapshotKey);
      },
      { mcpApps: true },
    );
  });

  it("returns model-readable error content when encrypted document sharing fails", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await withClient(
      false,
      async (client) => {
        const createResult = await client.callTool({
          name: "tabula_create_document",
          arguments: {
            title: "Failed Share",
            markdown: "# Failed Share\n\nThis plaintext must stay local.",
          },
        });
        const created = createResult.structuredContent as {
          document: { documentId: string };
        };

        const shareResult = await client.callTool({
          name: "tabula_share_document",
          arguments: { documentId: created.document.documentId },
        });
        const errorText = shareResult.content?.[0]?.type === "text" ? shareResult.content[0].text : "";

        expect(shareResult.isError).toBe(true);
        expect(errorText).toContain("Encrypted Tabula.md snapshot upload failed with HTTP 503: unavailable.");
        expect(errorText).not.toContain("This plaintext must stay local");
        expect(shareResult.structuredContent).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body);
        expect(body).not.toContain("This plaintext must stay local");
      },
      { mcpApps: true },
    );
  });
});
