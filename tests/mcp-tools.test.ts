import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore, type DocumentStoreDeploymentMode } from "../src/documents/store.js";
import type { RuntimeEnvironment } from "../src/env.js";
import { createTabulaMcpServer, resolveWriteEnabled } from "../src/index.js";

const originalFetch = globalThis.fetch;
const coreTools = [
  "tabula_start_session",
  "tabula_join_room",
  "tabula_list_files",
  "tabula_read_file",
  "tabula_search_files",
  "tabula_write_file",
  "tabula_write_files",
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
  it.each([false, true])("exposes exactly eight high-level tools (MCP Apps=%s)", async (mcpApps) => {
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
        "tabula_create_draft",
        "tabula_update_draft",
      ]) {
        expect(listed.tools.map((tool) => tool.name)).not.toContain(removed);
      }
    }, { mcpApps });
  });

  it("provides the workflow rules as server instructions", async () => {
    await withClient(async (client) => {
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("keep the URL private");
      expect(instructions).toContain("pass their revisions to Write File or Write Files");
      expect(instructions).toContain("Export Copy");
      expect(instructions).toContain("Start Session");
      expect(instructions).not.toContain("tabula_read_me");
    });
  });

  it("attaches the Tabula App only to completed handoff tools", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      for (const name of ["tabula_start_session", "tabula_export_copy"]) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(tool?._meta?.["ui/resourceUri"]).toMatch(/^ui:\/\/tabula\/document-[a-f0-9]{16}\.html$/);
      }
      for (const name of ["tabula_join_room", "tabula_list_files", "tabula_read_file", "tabula_search_files", "tabula_write_file", "tabula_write_files"]) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(tool?._meta?.["ui/resourceUri"]).toBeUndefined();
      }
    }, { mcpApps: true });
  });

  it("accepts host-native Markdown files instead of exposing a private draft API", async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const start = tools.tools.find((tool) => tool.name === "tabula_start_session");
      const exported = tools.tools.find((tool) => tool.name === "tabula_export_copy");
      expect(JSON.stringify(start?.inputSchema)).toContain('"files"');
      expect(JSON.stringify(start?.inputSchema)).not.toContain("draftId");
      expect(JSON.stringify(exported?.inputSchema)).toContain('"files"');
      expect(JSON.stringify(exported?.inputSchema)).not.toContain("draftId");
    });
  });

  it("exports one host-native file through the shared encrypted copy service", async () => {
    const snapshotId = "single_file_copy_123";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await withClient(async (client) => {
      const exported = await client.callTool({
        name: "tabula_export_copy",
        arguments: {
          source: {
            kind: "files",
            title: "Export me",
            files: [{ path: "export.md", content: "# Export me\n" }],
          },
        },
      });
      expect(exported.isError).not.toBe(true);
      expect(exported.structuredContent).toMatchObject({
        copyUrl: expect.stringMatching(new RegExp(`^https://tabula\\.md/#json=${snapshotId},`)),
        fileCount: 1,
        encrypted: true,
      });
    });
  });

  it("exports multiple inline files as one encrypted Tabula workspace copy", async () => {
    const snapshotId = "inline_workspace_copy_123";
    let uploadedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      uploadedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: snapshotId, data: `https://json.tabula.md/api/v2/${snapshotId}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await withClient(async (client) => {
      const exported = await client.callTool({
        name: "tabula_export_copy",
        arguments: {
          source: {
            kind: "files",
            title: "Three documents",
            files: [
              { path: "brief.md", content: "# Brief\n" },
              { path: "research/findings.md", content: "# Findings\n" },
              { path: "next-steps.md", content: "# Next steps\n" },
            ],
          },
        },
      });

      expect(exported.isError).not.toBe(true);
      expect(exported.structuredContent).toMatchObject({
        copyUrl: expect.stringMatching(new RegExp(`^https://tabula\\.md/#json=${snapshotId},`)),
        fileCount: 3,
        encrypted: true,
      });
      expect(exported.content?.find((item) => item.type === "text")?.text).not.toContain("#json=");
      expect(uploadedBody).not.toContain("# Brief");
      expect(uploadedBody).not.toContain("# Findings");
      expect(uploadedBody).not.toContain("# Next steps");
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
      const exported = await client.callTool({
        name: "tabula_export_copy",
        arguments: {
          source: {
            kind: "files",
            title: "Self hosted",
            files: [{ path: "self-hosted.md", content: "# Self hosted\n" }],
          },
        },
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

  it("keeps the same eight-tool contract in read-only mode", async () => {
    await withClient(async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(coreTools);
    }, { writeEnabled: false });
  });

  it("exposes only path-oriented Session resource templates", async () => {
    await withClient(async (client) => {
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
        "tabula://session/{sessionId}",
        "tabula://session/{sessionId}/file/{path}",
      ]);
      expect(JSON.stringify(templates)).not.toContain("documentId");
      expect(JSON.stringify(templates)).not.toContain("workspaceId");
    });
  });
});
