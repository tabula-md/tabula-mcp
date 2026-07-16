import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore, type DocumentStoreDeploymentMode } from "../src/documents/store.js";
import type { RuntimeEnvironment } from "../src/env.js";
import { createTabulaMcpServer, resolveWriteEnabled } from "../src/index.js";

const originalFetch = globalThis.fetch;
const coreTools = [
  "tabula_create_draft",
  "tabula_update_draft",
  "tabula_start_session",
  "tabula_join_room",
  "tabula_list_files",
  "tabula_read_file",
  "tabula_search_files",
  "tabula_write_file",
  "tabula_export_copy",
];

const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const withClient = async <T>(
  callback: (client: Client) => Promise<T>,
  options: {
    mcpApps?: boolean;
    writeEnabled?: boolean;
    deploymentMode?: DocumentStoreDeploymentMode;
    env?: RuntimeEnvironment;
  } = {},
) => {
  const instance = createTabulaMcpServer({
    writeEnabled: options.writeEnabled ?? true,
    documentStore: new MemoryDocumentStore(),
    deploymentMode: options.deploymentMode,
    env: options.env ?? {},
  });
  const client = new Client(
    { name: "tabula-core-test", version: "0.0.0" },
    options.mcpApps ? { capabilities: uiCapabilities } : undefined,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
    return await callback(client);
  } finally {
    await Promise.allSettled([client.close(), instance.server.close()]);
    instance.registry.clear();
    instance.workspaces.clear();
    await instance.documents.clear();
  }
};

const keysIn = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(keysIn);
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysIn(child)]);
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("write access configuration", () => {
  it("defaults to read/write so the MCP host governs mutation approval", () => {
    expect(resolveWriteEnabled({ env: {}, argv: [] })).toBe(true);
    expect(resolveWriteEnabled({ env: {}, argv: ["--read-only"] })).toBe(false);
  });
});

describe("core MCP contract", () => {
  it.each([false, true])("exposes exactly nine high-level tools (MCP Apps=%s)", async (mcpApps) => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(coreTools);
      expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeLessThan(14_000);

      for (const tool of listed.tools) {
        expect(tool.title).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
        expect(tool.outputSchema).toBeTruthy();
        expect(tool.annotations).toMatchObject({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: false,
          idempotentHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        });
      }

      const schemaKeys = listed.tools.flatMap((tool) => keysIn(tool.inputSchema));
      for (const lowLevelKey of ["changes", "patches", "from", "to", "insert"]) {
        expect(schemaKeys).not.toContain(lowLevelKey);
      }
      for (const removed of [
        "tabula_read_me",
        "tabula_create_document",
        "tabula_connect_room",
        "tabula_read_workspace",
        "tabula_apply_workspace_changes",
        "tabula_share_document",
        "tabula_share_workspace",
      ]) {
        expect(listed.tools.map((tool) => tool.name)).not.toContain(removed);
      }
    }, { mcpApps });
  });

  it("provides the workflow rules as server instructions", async () => {
    await withClient(async (client) => {
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("keep the URL private");
      expect(instructions).toContain("pass its revision to Write File");
      expect(instructions).toContain("Export Copy");
      expect(instructions).toContain("Start Session");
      expect(instructions).not.toContain("tabula_read_me");
    });
  });

  it("attaches the compact Tabula App to draft and session handoff tools", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      for (const name of ["tabula_create_draft", "tabula_update_draft", "tabula_start_session", "tabula_join_room"]) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(tool?._meta?.["ui/resourceUri"]).toMatch(/^ui:\/\/tabula\/document-[a-f0-9]{16}\.html$/);
      }
      for (const name of ["tabula_list_files", "tabula_read_file", "tabula_search_files", "tabula_write_file", "tabula_export_copy"]) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(tool?._meta?.["ui/resourceUri"]).toBeUndefined();
      }
    }, { mcpApps: true });
  });

  it("creates and updates a private draft with compact results", async () => {
    await withClient(async (client) => {
      const created = await client.callTool({
        name: "tabula_create_draft",
        arguments: { title: "Research", content: "# Research\n" },
      });
      expect(created.isError).not.toBe(true);
      const draft = created.structuredContent as { draftId: string; title: string; revision: string; textLength: number };
      expect(draft).toMatchObject({ title: "Research", textLength: 11 });
      expect(draft.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(created.content?.some((item) => item.type === "resource_link")).toBe(false);

      const resources = await client.listResources();
      const draftUri = `tabula://draft/${draft.draftId}`;
      expect(resources.resources.some((resource) => resource.uri.startsWith("tabula://draft/"))).toBe(false);
      expect(resources.resources.some((resource) => resource.uri.startsWith("tabula://workspace/"))).toBe(false);
      const draftResource = await client.readResource({ uri: draftUri });
      expect(draftResource.contents[0]).toMatchObject({
        uri: draftUri,
        mimeType: "text/markdown",
        text: "# Research\n",
        _meta: expect.objectContaining({ draftId: draft.draftId, revision: draft.revision }),
      });

      const updated = await client.callTool({
        name: "tabula_update_draft",
        arguments: {
          draftId: draft.draftId,
          content: "# Research\n\nDone\n",
          expectedRevision: draft.revision,
        },
      });
      expect(updated.structuredContent).toMatchObject({ draftId: draft.draftId, changed: true, textLength: 17 });

      const stale = await client.callTool({
        name: "tabula_update_draft",
        arguments: { draftId: draft.draftId, content: "stale", expectedRevision: draft.revision },
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toBeUndefined();
      const staleText = stale.content?.find((item) => item.type === "text")?.text ?? "{}";
      expect(JSON.parse(staleText)).toMatchObject({ code: "stale_revision", draftId: draft.draftId });
    });
  });

  it("exports a draft through the shared encrypted copy service", async () => {
    const snapshotId = "draft_copy_123";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await withClient(async (client) => {
      const created = await client.callTool({
        name: "tabula_create_draft",
        arguments: { title: "Export me", content: "# Export me\n" },
      });
      const draftId = (created.structuredContent as { draftId: string }).draftId;
      const exported = await client.callTool({
        name: "tabula_export_copy",
        arguments: { source: { kind: "draft", draftId } },
      });
      expect(exported.isError).not.toBe(true);
      expect(exported.structuredContent).toMatchObject({
        copyUrl: expect.stringMatching(new RegExp(`^https://tabula\\.md/#json=${snapshotId},`)),
        fileCount: 1,
        encrypted: true,
      });
    });
  });

  it("uses the configured app and JSON origins when exporting a copy", async () => {
    const snapshotId = "self_hosted_copy_123";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `https://json.example/api/v2/${snapshotId}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    globalThis.fetch = fetchMock as typeof fetch;

    await withClient(async (client) => {
      const created = await client.callTool({
        name: "tabula_create_draft",
        arguments: { title: "Self hosted", content: "# Self hosted\n" },
      });
      const draftId = (created.structuredContent as { draftId: string }).draftId;
      const exported = await client.callTool({
        name: "tabula_export_copy",
        arguments: { source: { kind: "draft", draftId } },
      });

      expect(exported.isError).not.toBe(true);
      expect(exported.structuredContent).toMatchObject({
        copyUrl: expect.stringMatching(new RegExp(`^https://tabula\\.example/#json=${snapshotId},`)),
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://json.example/api/v2/post/",
        expect.objectContaining({ method: "POST" }),
      );
    }, {
      env: {
        TABULA_APP_ORIGIN: "https://tabula.example",
        TABULA_JSON_URL: "https://json.example",
        TABULA_MCP_ALLOWED_JSON_SERVER_URLS: "https://json.example",
      },
    });
  });

  it("keeps the same nine-tool contract in read-only mode", async () => {
    await withClient(async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(coreTools);
    }, { writeEnabled: false });
  });

  it("exposes only path-oriented Draft and Session resource templates", async () => {
    await withClient(async (client) => {
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
        "tabula://draft/{draftId}",
        "tabula://session/{sessionId}",
        "tabula://session/{sessionId}/file/{path}",
      ]);
      expect(JSON.stringify(templates)).not.toContain("documentId");
      expect(JSON.stringify(templates)).not.toContain("workspaceId");
    });
  });
});
