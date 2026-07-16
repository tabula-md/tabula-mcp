import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentAppResource } from "../src/app/resource.js";
import { MemoryDocumentStore, type DocumentStoreDeploymentMode } from "../src/documents/store.js";
import { createTabulaMcpServer, resolveWriteEnabled } from "../src/index.js";
import { workspaceDocumentResourceUri, workspaceResourceUri } from "../src/workspace-resources.js";

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
  options: { env?: Record<string, string | undefined>; mcpApps?: boolean; deploymentMode?: DocumentStoreDeploymentMode } = {},
) => {
  const env = Object.hasOwn(options, "env") ? options.env : {};
  const { server, registry, workspaces, documents } = createTabulaMcpServer({
    writeEnabled,
    documentStore: new MemoryDocumentStore(),
    env,
    deploymentMode: options.deploymentMode,
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
    workspaces.clear();
    documents.clear();
  }
};

const listTools = async (writeEnabled: boolean, options: { mcpApps?: boolean } = {}) =>
  withClient(writeEnabled, (client) => client.listTools(), options);

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("write access configuration", () => {
  it("defaults to read/write so the MCP host can govern mutation approval", () => {
    expect(resolveWriteEnabled({ env: {}, argv: [] })).toBe(true);
  });

  it("keeps the legacy environment variable compatible", () => {
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "1" }, argv: [] })).toBe(true);
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "true" }, argv: [] })).toBe(true);
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "YES" }, argv: [] })).toBe(true);
  });

  it("keeps the CLI alias and lets --read-only override it", () => {
    expect(resolveWriteEnabled({ env: {}, argv: ["--enable-write"] })).toBe(true);
    expect(resolveWriteEnabled({ env: { TABULA_MCP_ENABLE_WRITE: "1" }, argv: ["--read-only"] })).toBe(false);
  });
});

describe("MCP tool registration", () => {
  it("fingerprints the App resource URI so hosts do not reuse stale bundled UI", () => {
    const first = createDocumentAppResource({ documentAppHtml: "<!doctype html><title>First Session Card</title>" });
    const next = createDocumentAppResource({ documentAppHtml: "<!doctype html><title>Next Session Card</title>" });

    expect(first.uri).toMatch(/^ui:\/\/tabula\/document-[a-f0-9]{16}\.html$/);
    expect(next.uri).toMatch(/^ui:\/\/tabula\/document-[a-f0-9]{16}\.html$/);
    expect(next.uri).not.toBe(first.uri);
  });

  it("does not expose the patch tool or writeAccess input in read-only mode", async () => {
    const tools = await listTools(false);
    const toolNames = tools.tools.map((tool) => tool.name);
    const connectTool = tools.tools.find((tool) => tool.name === "tabula_connect_room");
    const listSessionsTool = tools.tools.find((tool) => tool.name === "tabula_list_sessions");
    const statusTool = tools.tools.find((tool) => tool.name === "tabula_room_status");
    const createWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_create_workspace");
    const importWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_import_markdown_workspace");
    const shareWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_share_workspace");
    const createWorkspaceRoomTool = tools.tools.find((tool) => tool.name === "tabula_create_workspace_room");
    const readWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_read_workspace");
    const readWorkspaceDocumentTool = tools.tools.find((tool) => tool.name === "tabula_read_workspace_document");
    const readWorkspaceContextTool = tools.tools.find((tool) => tool.name === "tabula_read_workspace_context");
    const applyWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_apply_workspace_changes");
    const setPresenceTool = tools.tools.find((tool) => tool.name === "tabula_set_presence");
    const waitTool = tools.tools.find((tool) => tool.name === "tabula_wait_for_changes");
    const disconnectTool = tools.tools.find((tool) => tool.name === "tabula_disconnect_room");

    expect(toolNames).toContain("tabula_read_me");
    expect(toolNames).toContain("tabula_create_workspace");
    expect(toolNames).toContain("tabula_import_markdown_workspace");
    expect(toolNames).toContain("tabula_share_workspace");
    expect(toolNames).toContain("tabula_create_workspace_room");
    expect(toolNames).toContain("tabula_read_workspace");
    expect(toolNames).toContain("tabula_read_workspace_document");
    expect(toolNames).toContain("tabula_read_workspace_context");
    expect(toolNames).toContain("tabula_apply_workspace_changes");
    expect(toolNames).not.toContain("tabula_read_markdown");
    expect(toolNames).not.toContain("tabula_get_outline");
    expect(toolNames).not.toContain("tabula_propose_text_patches");
    expect(toolNames).not.toContain("tabula_apply_text_patches");
    expect(jsonBytes(tools)).toBeLessThan(36_000);
    expect(connectTool?.inputSchema.properties).not.toHaveProperty("writeAccess");
    expect(connectTool?.inputSchema.properties).toHaveProperty("waitForStateMs");
    expect(createWorkspaceTool?.inputSchema.properties).toHaveProperty("files");
    expect(createWorkspaceTool?.inputSchema.properties).toHaveProperty("detail");
    expect(importWorkspaceTool?.inputSchema.properties).toHaveProperty("source");
    expect(importWorkspaceTool?.inputSchema.properties).toHaveProperty("detail");
    expect(shareWorkspaceTool?.inputSchema.properties).toHaveProperty("workspaceId");
    expect(createWorkspaceRoomTool?.inputSchema.properties).toHaveProperty("workspaceId");
    expect(readWorkspaceTool?.inputSchema.properties).toHaveProperty("detail");
    expect(readWorkspaceDocumentTool?.inputSchema.properties).toHaveProperty("documentId");
    expect(readWorkspaceContextTool?.inputSchema.properties).toHaveProperty("maxTotalChars");
    expect(applyWorkspaceTool?.inputSchema.properties).toHaveProperty("changes");
    expect(setPresenceTool?.inputSchema.properties).toHaveProperty("selection");
    expect(waitTool?.inputSchema.properties).toHaveProperty("includeMarkdown");
    expect(disconnectTool?.inputSchema.properties).toHaveProperty("sessionId");
    for (const tool of [
      connectTool,
      listSessionsTool,
      statusTool,
      createWorkspaceTool,
      importWorkspaceTool,
      shareWorkspaceTool,
      createWorkspaceRoomTool,
      readWorkspaceTool,
      readWorkspaceDocumentTool,
      readWorkspaceContextTool,
      applyWorkspaceTool,
      setPresenceTool,
      waitTool,
      disconnectTool,
    ]) {
      expect(tool?.outputSchema).toBeUndefined();
    }
    expect(connectTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it("does not expose legacy single-document patch tools when server-level write mode is enabled", async () => {
    const tools = await listTools(true);
    const toolNames = tools.tools.map((tool) => tool.name);
    const applyWorkspaceTool = tools.tools.find((tool) => tool.name === "tabula_apply_workspace_changes");

    expect(applyWorkspaceTool).toBeDefined();
    expect(toolNames).not.toContain("tabula_propose_text_patches");
    expect(toolNames).not.toContain("tabula_apply_text_patches");
    expect(applyWorkspaceTool?.inputSchema.properties).toHaveProperty("changes");
    expect(applyWorkspaceTool?.outputSchema).toBeUndefined();
  });

  it("returns structured content from model-facing JSON room tools", async () => {
    await withClient(false, async (client) => {
      const result = await client.callTool({
        name: "tabula_list_sessions",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        sessions: [],
      });
    });
  });

  it("does not let hosted MCP create a temporary Room without encrypted recovery", async () => {
    await withClient(true, async (client) => {
      const created = await client.callTool({
        name: "tabula_create_workspace",
        arguments: {
          title: "Remote workspace",
          files: [{ path: "README.md", markdown: "# Remote workspace\n" }],
        },
      });
      const workspaceId = (created.structuredContent as { workspaceId: string }).workspaceId;
      const started = await client.callTool({
        name: "tabula_create_workspace_room",
        arguments: { workspaceId },
      });
      const text = started.content?.find((item) => item.type === "text");

      expect(started.isError).toBe(true);
      expect(text).toMatchObject({
        text: expect.stringContaining("Hosted Tabula MCP can start a live session only when encrypted room persistence is configured"),
      });
    }, { deploymentMode: "remote" });
  });

  it("creates, reads, imports, and shares model-facing workspaces without MCP Apps", async () => {
    const snapshotId = "workspace_snapshot_123";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await withClient(false, async (client) => {
      const createResult = await client.callTool({
        name: "tabula_create_workspace",
        arguments: {
          title: "Agent Workspace",
          files: [
            { path: "README.md", markdown: "# Agent Workspace\n" },
            { path: "docs/Plan.md", title: "Plan", markdown: "# Plan\n\nShip workspace tools.\n" },
          ],
        },
      });
      const created = createResult.structuredContent as {
        workspaceId: string;
        resourceUri: string;
        workspace: null;
        workspaceSummary: { activeDocumentId: string; nodeCount: number; folderCount: number; documentCount: number };
        documents: Array<{ id: string; title: string; cached: boolean; path?: string; resourceUri: string }>;
      };
      const expectedWorkspaceResourceUri = workspaceResourceUri(created.workspaceId);

      expect(created.workspaceId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(created.resourceUri).toBe(expectedWorkspaceResourceUri);
      expect(createResult.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "resource_link",
            uri: expectedWorkspaceResourceUri,
          }),
        ]),
      );
      expect(created.workspace).toBeNull();
      expect(created.workspaceSummary).toMatchObject({
        folderCount: 2,
        documentCount: 2,
        nodeCount: 4,
      });
      expect(created.documents.every((document) => document.cached)).toBe(true);

      const planDocumentId = created.documents.find((document) => document.title === "Plan")?.id ?? "";
      const planDocumentResourceUri = workspaceDocumentResourceUri(created.workspaceId, planDocumentId);
      expect(created.documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: planDocumentId,
            resourceUri: planDocumentResourceUri,
          }),
        ]),
      );

      const resourceTemplates = await client.listResourceTemplates();
      expect(resourceTemplates.resourceTemplates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "tabula-workspace",
            uriTemplate: "tabula://workspace/{workspaceId}",
          }),
          expect.objectContaining({
            name: "tabula-workspace-document",
            uriTemplate: "tabula://workspace/{workspaceId}/document/{documentId}",
          }),
        ]),
      );

      const resources = await client.listResources();
      expect(resources.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            uri: expectedWorkspaceResourceUri,
            mimeType: "application/json",
          }),
          expect.objectContaining({
            uri: planDocumentResourceUri,
            mimeType: "text/markdown",
          }),
        ]),
      );

      const workspaceResource = await client.readResource({ uri: expectedWorkspaceResourceUri });
      const workspaceResourceText =
        workspaceResource.contents[0] && "text" in workspaceResource.contents[0] ? workspaceResource.contents[0].text : "";
      expect(JSON.parse(workspaceResourceText)).toMatchObject({
        workspaceId: created.workspaceId,
        resourceUri: expectedWorkspaceResourceUri,
        documents: expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String),
            resourceUri: expect.stringMatching(new RegExp(`^tabula://workspace/${created.workspaceId}/document/`)),
          }),
        ]),
      });

      const markdownResource = await client.readResource({ uri: planDocumentResourceUri });
      expect(markdownResource.contents[0]).toMatchObject({
        uri: planDocumentResourceUri,
        mimeType: "text/markdown",
        text: "# Plan\n\nShip workspace tools.\n",
      });

      const readResult = await client.callTool({
        name: "tabula_read_workspace",
        arguments: { workspaceId: created.workspaceId },
      });
      expect(readResult.structuredContent).toMatchObject({
        workspaceId: created.workspaceId,
        resourceUri: expectedWorkspaceResourceUri,
        workspace: null,
        workspaceSummary: expect.objectContaining({ documentCount: 2 }),
        cachedDocumentCount: 2,
        hydrationStatus: "ready",
        stateReceived: true,
      });

      const treeResult = await client.callTool({
        name: "tabula_read_workspace",
        arguments: { workspaceId: created.workspaceId, detail: "tree" },
      });
      expect(treeResult.structuredContent).toMatchObject({
        workspaceId: created.workspaceId,
        workspace: {
          nodes: expect.arrayContaining([
            expect.objectContaining({ type: "folder", title: "Agent Workspace" }),
            expect.objectContaining({ type: "folder", title: "docs" }),
            expect.objectContaining({ type: "document", title: "README.md" }),
            expect.objectContaining({ type: "document", title: "Plan" }),
          ]),
        },
      });

      const documentResult = await client.callTool({
        name: "tabula_read_workspace_document",
        arguments: { workspaceId: created.workspaceId, documentId: planDocumentId },
      });
      const planDocument = documentResult.structuredContent as {
        workspaceId: string;
        documentId: string;
        path: string;
        markdown: string;
        sha256: string;
        resourceUri: string;
      };
      expect(documentResult.structuredContent).toMatchObject({
        workspaceId: created.workspaceId,
        documentId: planDocumentId,
        path: "docs/Plan.md",
        markdown: "# Plan\n\nShip workspace tools.\n",
        resourceUri: planDocumentResourceUri,
      });

      const contextResult = await client.callTool({
        name: "tabula_read_workspace_context",
        arguments: {
          workspaceId: created.workspaceId,
          documentIds: [planDocumentId],
          maxCharsPerDocument: 200,
        },
      });
      expect(contextResult.structuredContent).toMatchObject({
        workspaceId: created.workspaceId,
        documents: [
          expect.objectContaining({
            documentId: planDocumentId,
            resourceUri: planDocumentResourceUri,
            markdownExcerpt: "# Plan\n\nShip workspace tools.\n",
            selectionReasons: ["document-id"],
            truncated: false,
          }),
        ],
        totalIncludedChars: "# Plan\n\nShip workspace tools.\n".length,
        truncatedDocumentCount: 0,
        matchedDocumentCount: 1,
        budgetExhausted: false,
      });

      const filteredContextResult = await client.callTool({
        name: "tabula_read_workspace_context",
        arguments: {
          workspaceId: created.workspaceId,
          pathGlobs: ["docs/*"],
          query: "Ship workspace",
          changedSince: {
            [planDocumentId]: "0".repeat(64),
          },
          maxCharsPerDocument: 200,
        },
      });
      expect(filteredContextResult.structuredContent).toMatchObject({
        workspaceId: created.workspaceId,
        documents: [
          expect.objectContaining({
            documentId: planDocumentId,
            selectionReasons: expect.arrayContaining(["path-glob", "changed-since", "query-markdown"]),
          }),
        ],
        matchedDocumentCount: 1,
      });

      const unchangedContextResult = await client.callTool({
        name: "tabula_read_workspace_context",
        arguments: {
          workspaceId: created.workspaceId,
          pathGlobs: ["docs/*"],
          changedSince: {
            [planDocumentId]: planDocument.sha256,
          },
        },
      });
      expect(unchangedContextResult.structuredContent).toMatchObject({
        workspaceId: created.workspaceId,
        documents: [],
        matchedDocumentCount: 0,
      });

      const importResult = await client.callTool({
        name: "tabula_import_markdown_workspace",
        arguments: {
          title: "Inline Import",
          source: {
            type: "files",
            files: [{ path: "notes/One.md", markdown: "# One\n" }],
          },
        },
      });
      expect(importResult.structuredContent).toMatchObject({
        source: "imported",
        cachedDocumentCount: 1,
      });

      const shareResult = await client.callTool({
        name: "tabula_share_workspace",
        arguments: { workspaceId: created.workspaceId },
      });
      const shared = shareResult.structuredContent as {
        share: { fileCount: number; textLength: number; shareUrl: string; snapshotId: string };
      };

      expect(shared.share).toMatchObject({
        snapshotId,
        fileCount: 2,
        textLength: "# Agent Workspace\n".length + "# Plan\n\nShip workspace tools.\n".length,
      });
      expect(shared.share.shareUrl).toMatch(new RegExp(`^https://tabula\\.md/#json=${snapshotId},`));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = Buffer.from((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as ArrayBuffer).toString("utf8");
      expect(body).not.toContain("Ship workspace tools");
      expect(body).not.toContain(new URL(shared.share.shareUrl).hash.split(",")[1] ?? "");
    });
  });

  it("requires client roots or an explicit allowlist for local-path workspace import", async () => {
    const root = path.join(tmpdir(), `tabula-mcp-import-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Imported\n", "utf8");
    const resolvedRoot = await realpath(root);

    try {
      await withClient(false, async (client) => {
        const denied = await client.callTool({
          name: "tabula_import_markdown_workspace",
          arguments: {
            source: {
              type: "local-path",
              rootPath: root,
            },
          },
        });

        expect(denied.isError).toBe(true);
        const text = denied.content?.[0]?.type === "text" ? denied.content[0].text : "";
        expect(text).toContain("TABULA_MCP_ALLOWED_IMPORT_ROOTS");
      });

      await withClient(
        false,
        async (client) => {
          const imported = await client.callTool({
            name: "tabula_import_markdown_workspace",
            arguments: {
              title: "Allowed Import",
              source: {
                type: "local-path",
                rootPath: root,
              },
            },
          });

          expect(imported.isError).not.toBe(true);
          expect(imported.structuredContent).toMatchObject({
            source: "imported",
            sourceRootPath: resolvedRoot,
            cachedDocumentCount: 1,
            documents: [
              expect.objectContaining({
                path: "README.md",
                title: "README.md",
              }),
            ],
          });
        },
        { env: { TABULA_MCP_ALLOWED_IMPORT_ROOTS: root } },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses process.env as the default runtime env for stdio-style servers", async () => {
    const root = path.join(tmpdir(), `tabula-mcp-import-env-${randomUUID()}`);
    const previousAllowedRoots = process.env.TABULA_MCP_ALLOWED_IMPORT_ROOTS;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Imported From Env\n", "utf8");

    process.env.TABULA_MCP_ALLOWED_IMPORT_ROOTS = root;
    const { server, registry, workspaces, documents } = createTabulaMcpServer({
      writeEnabled: false,
      documentStore: new MemoryDocumentStore(),
    });
    const client = new Client({ name: "tabula-mcp-env-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const imported = await client.callTool({
        name: "tabula_import_markdown_workspace",
        arguments: {
          source: {
            type: "local-path",
            rootPath: root,
          },
        },
      });

      expect(imported.isError).not.toBe(true);
      expect(imported.structuredContent).toMatchObject({
        source: "imported",
        cachedDocumentCount: 1,
      });
    } finally {
      if (previousAllowedRoots === undefined) {
        delete process.env.TABULA_MCP_ALLOWED_IMPORT_ROOTS;
      } else {
        process.env.TABULA_MCP_ALLOWED_IMPORT_ROOTS = previousAllowedRoots;
      }
      await Promise.allSettled([client.close(), server.close()]);
      registry.clear();
      workspaces.clear();
      documents.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns model guidance through tabula_read_me without requiring MCP Apps", async () => {
    await withClient(false, async (client) => {
      const tools = await client.listTools();
      const readMeTool = tools.tools.find((tool) => tool.name === "tabula_read_me");
      expect(readMeTool?.outputSchema).toBeUndefined();

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
        runtime: {
          version: string;
          deploymentMode: string;
          writeAccess: string;
          trustBoundary: string;
        };
      };

      expect(text).toContain("Tabula.md MCP read_me (sharing)");
      expect(text).toContain("bearer secret");
      expect(text).toContain("Write access: read-only");
      expect(structured.readMe.topic).toBe("sharing");
      expect(structured.readMe.nextActions.length).toBeGreaterThan(0);
      expect(structured.readMe.securityRules.join("\n")).toContain("#room");
      expect(structured.runtime).toMatchObject({
        version: "0.1.6",
        deploymentMode: "local",
        writeAccess: "read-only",
      });
      expect(structured.runtime.trustBoundary).toContain("model provider");
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
    expect(toolNames).not.toContain("tabula_app_start_room_from_document");
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
    const appStartRoomTool = tools.tools.find((tool) => tool.name === "tabula_app_start_room_from_document");
    const documentAppResourceUri = createDocumentTool?._meta?.["ui/resourceUri"];

    expect(jsonBytes(tools)).toBeLessThan(48_000);
    expect(documentAppResourceUri).toMatch(/^ui:\/\/tabula\/document-[a-f0-9]{16}\.html$/);
    expect(createDocumentTool?._meta).toMatchObject({
      ui: {
        resourceUri: documentAppResourceUri,
      },
      "ui/resourceUri": documentAppResourceUri,
    });
    expect(createDocumentTool?.annotations?.readOnlyHint).toBe(false);
    expect(listDocumentsTool?.annotations?.readOnlyHint).toBe(true);
    expect(openDocumentTool?._meta).toMatchObject({
      ui: {
        resourceUri: documentAppResourceUri,
      },
      "ui/resourceUri": documentAppResourceUri,
    });
    expect(openDocumentTool?.annotations?.readOnlyHint).toBe(true);
    expect(roomViewTool?._meta).toMatchObject({
      ui: {
        resourceUri: documentAppResourceUri,
      },
      "ui/resourceUri": documentAppResourceUri,
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
    expect(appStartRoomTool?._meta).toMatchObject({
      ui: {
        visibility: ["app"],
      },
    });
    for (const tool of [
      createDocumentTool,
      listDocumentsTool,
      openDocumentTool,
      roomViewTool,
      shareDocumentTool,
      appSnapshotTool,
      appDocumentSnapshotTool,
      appSaveDocumentTool,
      appStartRoomTool,
    ]) {
      expect(tool?.outputSchema).toBeUndefined();
    }
  });

  it("serves the Tabula Document resource as an MCP App HTML resource", async () => {
    await withClient(false, async (client) => {
      const resources = await client.listResources();
      const documentAppResource = resources.resources.find((resource) =>
        /^ui:\/\/tabula\/document-[a-f0-9]{16}\.html$/.test(resource.uri),
      );
      expect(documentAppResource).toBeDefined();

      const resource = await client.readResource({ uri: documentAppResource?.uri ?? "" });
      expect(resource.contents[0]).toMatchObject({
        uri: documentAppResource?.uri,
        mimeType: "text/html;profile=mcp-app",
      });
      expect("text" in resource.contents[0] ? resource.contents[0].text : "").toContain("<title>Tabula Session</title>");
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
