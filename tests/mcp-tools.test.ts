import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploymentMode } from "../src/deployment.js";
import type { RuntimeEnvironment } from "../src/env.js";
import { createTabulaMcpServer, resolveWriteEnabled } from "../src/index.js";
import { CORE_TOOL_METADATA, CORE_TOOL_NAMES } from "../src/server/tool-metadata.js";
import { createEncryptedJsonShareWorkspaceSnapshot, generateJsonShareKey } from "../src/share.js";

const originalFetch = globalThis.fetch;
const coreTools = [...CORE_TOOL_NAMES];

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
    deploymentMode?: DeploymentMode;
    env?: RuntimeEnvironment;
  } = {},
) => {
  const instance = createTabulaMcpServer({
    writeEnabled: options.writeEnabled ?? true,
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
    await instance.registry.clear();
  }
};

const keysIn = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(keysIn);
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysIn(child)]);
};

const expectInputPropertiesDescribed = (schema: unknown, path = "inputSchema") => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const value = schema as Record<string, unknown>;
  if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
    for (const [name, propertySchema] of Object.entries(value.properties)) {
      const property = propertySchema as Record<string, unknown>;
      expect(property.description, `${path}.${name} needs a description`).toEqual(expect.any(String));
      expectInputPropertiesDescribed(property, `${path}.${name}`);
    }
  }
  expectInputPropertiesDescribed(value.items, `${path}[]`);
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(value[keyword])) {
      value[keyword].forEach((child, index) => expectInputPropertiesDescribed(child, `${path}.${keyword}[${index}]`));
    }
  }
};

const expectTypedToolError = (
  result: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
  },
  code: string,
) => {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    code,
    message: expect.any(String),
    details: expect.any(Object),
  });
  const text = result.content?.find((item) => item.type === "text")?.text;
  expect(JSON.parse(text ?? "{}")).toEqual(result.structuredContent);
  return result.structuredContent!;
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
  it("publishes a selection-oriented server identity", async () => {
    await withClient(async (client) => {
      expect(client.getServerVersion()).toMatchObject({
        name: "tabula-mcp",
        title: "Tabula.md",
        description: expect.stringContaining("Select this server only for an explicit Tabula.md request"),
        websiteUrl: "https://tabula.md",
        icons: [
          {
            src: "https://tabula.md/favicon.svg",
            mimeType: "image/svg+xml",
          },
        ],
      });
      expect(client.getServerVersion()?.description).toContain("Codex, Claude, or host-native document artifacts and canvases");
    });
  });

  it.each([false, true])("exposes exactly twenty high-level tools (MCP Apps=%s)", async (mcpApps) => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(coreTools);
      expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeLessThan(40_000);

      for (const tool of listed.tools) {
        expect(Buffer.byteLength(JSON.stringify(tool), "utf8")).toBeLessThan(4_000);
        expect(tool.title).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
        expect(tool.outputSchema).toBeTruthy();
        expectInputPropertiesDescribed(tool.inputSchema, tool.name);
        const destructive = [
          "write_files",
          "write_file",
          "edit_file",
          "move_file",
          "delete_path",
          "delete_comment",
        ].includes(tool.name);
        expect(tool.annotations).toMatchObject({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: destructive,
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
        "tabula_start_session",
        "tabula_join_room",
        "tabula_list_files",
        "tabula_read_file",
        "tabula_read_files",
        "tabula_search_files",
        "tabula_write_file",
        "tabula_write_files",
        "tabula_edit_file",
        "tabula_create_directory",
        "tabula_move_file",
        "tabula_delete_path",
        "tabula_import_copy",
        "tabula_export_copy",
      ]) {
        expect(listed.tools.map((tool) => tool.name)).not.toContain(removed);
      }
    }, { mcpApps });
  });

  it("provides the workflow rules as server instructions", async () => {
    await withClient(async (client) => {
      const instructions = client.getInstructions() ?? "";
      const discoveryPrefix = instructions.slice(0, 512);
      expect(discoveryPrefix).toContain("Select Tabula.md only for an explicit Tabula.md request");
      expect(discoveryPrefix).toContain("Codex, Claude, or host-native document artifacts and canvases");
      expect(discoveryPrefix).toContain("#room");
      expect(discoveryPrefix).toContain("#json");
      expect(instructions).toContain("Keep every room and copy URL private");
      expect(instructions).toContain("Use Read File for one file");
      expect(instructions).toContain("Read Multiple Files for a small batch");
      expect(instructions).toContain("pass their revisions to Write File, Write Files, Edit File, Move or Rename, or Delete Path");
      expect(instructions).toContain("Use Edit File for small exact replacements");
      expect(instructions).toContain("Move or Rename accepts files and directories");
      expect(instructions).toContain("Use List Comments");
      expect(instructions).toContain("inclusive startLine and endLine together");
      expect(instructions).toContain("Export Copy");
      expect(instructions).toContain("Import Copy");
      expect(instructions).toContain("does not join a live session");
      expect(instructions).toContain("Start Session");
      expect(instructions).toContain("structured code, message, details, and optional retry fields");
      expect(instructions).toContain("input schema failures remain standard MCP validation errors");
      expect(instructions).not.toContain("tabula_read_me");
    });
  });

  it.each([
    ["list_files", { sessionId: "00000000-0000-4000-8000-000000000099" }],
    ["read_file", { sessionId: "00000000-0000-4000-8000-000000000099", path: "missing.md" }],
    ["read_multiple_files", { sessionId: "00000000-0000-4000-8000-000000000099", paths: ["missing.md"] }],
    ["search_files", { sessionId: "00000000-0000-4000-8000-000000000099", query: "missing" }],
    ["list_comments", { sessionId: "00000000-0000-4000-8000-000000000099" }],
    ["add_comment", {
      sessionId: "00000000-0000-4000-8000-000000000099",
      path: "missing.md",
      body: "Review this.",
    }],
    ["reply_to_comment", {
      sessionId: "00000000-0000-4000-8000-000000000099",
      commentId: "00000000-0000-4000-8000-000000000001",
      body: "Done.",
    }],
    ["resolve_comment", {
      sessionId: "00000000-0000-4000-8000-000000000099",
      commentId: "00000000-0000-4000-8000-000000000001",
      resolved: true,
    }],
    ["delete_comment", {
      sessionId: "00000000-0000-4000-8000-000000000099",
      commentId: "00000000-0000-4000-8000-000000000001",
    }],
    ["write_file", { sessionId: "00000000-0000-4000-8000-000000000099", path: "new.md", content: "# New\n" }],
    ["write_files", { sessionId: "00000000-0000-4000-8000-000000000099", files: [{ path: "new.md", content: "# New\n" }] }],
    ["edit_file", {
      sessionId: "00000000-0000-4000-8000-000000000099",
      path: "missing.md",
      expectedRevision: "0".repeat(64),
      edits: [{ oldText: "old", newText: "new" }],
    }],
    ["create_directory", { sessionId: "00000000-0000-4000-8000-000000000099", path: "docs" }],
    ["move_file", {
      sessionId: "00000000-0000-4000-8000-000000000099",
      source: "a.md",
      destination: "b.md",
      expectedRevision: "0".repeat(64),
    }],
    ["delete_path", {
      sessionId: "00000000-0000-4000-8000-000000000099",
      path: "a.md",
      expectedRevision: "0".repeat(64),
    }],
    ["export_copy", { sessionId: "00000000-0000-4000-8000-000000000099" }],
  ])("returns the typed execution-error envelope from %s", async (name, argumentsValue) => {
    await withClient(async (client) => {
      const result = await client.callTool({ name, arguments: argumentsValue });
      const error = expectTypedToolError(result, "session_not_found");
      expect(error.details).toEqual({ sessionId: "00000000-0000-4000-8000-000000000099" });
      expect(error.retry).toEqual(expect.any(String));
    });
  });

  it("returns typed errors from the three session and handoff entry points", async () => {
    await withClient(async (client) => {
      const started = await client.callTool({
        name: "start_session",
        arguments: { files: [{ path: "a.md", content: "# A\n" }] },
      });
      expectTypedToolError(started, "write_disabled");

      const joined = await client.callTool({
        name: "join_room",
        arguments: { roomUrl: "https://tabula.md/" },
      });
      expectTypedToolError(joined, "invalid_input");

      const imported = await client.callTool({
        name: "import_copy",
        arguments: { copyUrl: "https://tabula.md/" },
      });
      expectTypedToolError(imported, "invalid_input");
    }, { writeEnabled: false });
  });

  it("keeps Leave Session idempotent instead of reporting an error for an unknown session", async () => {
    await withClient(async (client) => {
      const sessionId = "00000000-0000-4000-8000-000000000099";
      const result = await client.callTool({ name: "leave_session", arguments: { sessionId } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ sessionId, left: false, reason: "already_left" });
    });
  });

  it("uses concise titles and decision-oriented descriptions", async () => {
    await withClient(async (client) => {
      const tools = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      for (const name of coreTools) {
        expect(tools[name]?.title).toBe(CORE_TOOL_METADATA[name].title);
        expect(tools[name]?.description).toBe(CORE_TOOL_METADATA[name].description);
        expect(tools[name]?.description).toMatch(/^Use this when/);
        expect(tools[name]?.description).toContain("Tabula.md");
        expect(CORE_TOOL_METADATA[name].description.length).toBeLessThanOrEqual(240);
      }
      for (const name of [
        "start_session",
        "list_files",
        "read_file",
        "read_multiple_files",
        "search_files",
        "write_file",
        "write_files",
      ]) {
        expect(tools[name]?.description).toMatch(/Do not|do not|Never/);
      }
      expect(tools.move_file?.inputSchema.properties?.destination?.description)
        .toContain("parent directory already exists");
    });
  });

  it("attaches the Tabula App only to completed handoff tools", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      for (const name of ["start_session", "export_copy"]) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(tool?._meta?.["ui/resourceUri"]).toMatch(/^ui:\/\/tabula\/document-[a-f0-9]{16}\.html$/);
      }
      for (const name of [
        "join_room",
        "leave_session",
        "list_files",
        "read_file",
        "read_multiple_files",
        "search_files",
        "list_comments",
        "add_comment",
        "reply_to_comment",
        "resolve_comment",
        "delete_comment",
        "write_file",
        "write_files",
        "edit_file",
        "create_directory",
        "move_file",
        "delete_path",
        "import_copy",
      ]) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(tool?._meta?.["ui/resourceUri"]).toBeUndefined();
      }
    }, { mcpApps: true });
  });

  it("provides focused single-file tools alongside atomic batch tools", async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const read = tools.tools.find((tool) => tool.name === "read_file");
      const readMany = tools.tools.find((tool) => tool.name === "read_multiple_files");
      const write = tools.tools.find((tool) => tool.name === "write_file");
      const writeMany = tools.tools.find((tool) => tool.name === "write_files");
      expect(JSON.stringify(read?.inputSchema)).toContain('"tailLines"');
      expect(JSON.stringify(read?.inputSchema)).toContain('"startLine"');
      expect(JSON.stringify(readMany?.inputSchema)).toContain('"paths"');
      expect(JSON.stringify(write?.inputSchema)).toContain('"content"');
      expect(JSON.stringify(writeMany?.inputSchema)).toContain('"files"');
    });
  });

  it("accepts host-native Markdown files instead of exposing a private draft API", async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const start = tools.tools.find((tool) => tool.name === "start_session");
      const exported = tools.tools.find((tool) => tool.name === "export_copy");
      expect(JSON.stringify(start?.inputSchema)).toContain('"files"');
      expect(JSON.stringify(start?.inputSchema)).not.toContain("draftId");
      expect(JSON.stringify(exported?.inputSchema)).toContain('"files"');
      expect(JSON.stringify(exported?.inputSchema)).not.toContain("draftId");

      const exportSchema = exported?.inputSchema as {
        properties?: Record<string, { description?: string }>;
        examples?: unknown[];
      };
      expect(Object.keys(exportSchema.properties ?? {})).toEqual(["title", "files", "sessionId", "paths"]);
      expect(exportSchema.properties?.files?.description).toContain("never both");
      expect(exportSchema.properties?.sessionId?.description).toContain("never both");
      expect(exportSchema.examples).toEqual([
        { files: [{ path: "sample.md", content: "# Sample\n" }] },
        { sessionId: "00000000-0000-4000-8000-000000000000", paths: ["sample.md"] },
      ]);
      expect(JSON.stringify(exportSchema)).not.toContain('"source"');
      expect(JSON.stringify(exportSchema)).not.toContain('"kind"');
      expect(JSON.stringify(exportSchema)).not.toContain('"oneOf"');
    });
  });

  it.each([
    [{}, "exactly one source"],
    [{ files: [{ path: "sample.md", content: "# Sample\n" }], sessionId: "00000000-0000-4000-8000-000000000000" }, "exactly one source"],
    [{ files: [{ path: "sample.md", content: "# Sample\n" }], paths: ["sample.md"] }, "paths can only be used with sessionId"],
    [{ sessionId: "00000000-0000-4000-8000-000000000000", title: "Sample" }, "title can only be used with files"],
    [{ source: { kind: "files", files: [{ path: "sample.md", content: "# Sample\n" }] } }, "exactly one source"],
  ])("returns one actionable tool error for invalid Export Copy input %#", async (argumentsValue, message) => {
    await withClient(async (client) => {
      const exported = await client.callTool({
        name: "export_copy",
        arguments: argumentsValue,
      });
      expect(exported.isError).toBe(true);
      const error = JSON.parse(exported.content?.find((item) => item.type === "text")?.text ?? "{}");
      expect(error).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining(message),
        details: {
          expected: expect.stringContaining("files"),
          examples: [
            { files: [{ path: "sample.md", content: "# Sample\n" }] },
            { sessionId: "00000000-0000-4000-8000-000000000000", paths: ["sample.md"] },
          ],
        },
        retry: expect.stringContaining("exactly one of files or sessionId"),
      });
      expect(exported.structuredContent).toEqual(error);
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
        name: "export_copy",
        arguments: {
          title: "Export me",
          files: [{ path: "export.md", content: "# Export me\n" }],
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
        name: "export_copy",
        arguments: {
          title: "Three documents",
          files: [
            { path: "brief.md", content: "# Brief\n" },
            { path: "research/findings.md", content: "# Findings\n" },
            { path: "next-steps.md", content: "# Next steps\n" },
          ],
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

  it("imports one encrypted copy as relative Markdown paths without joining a session", async () => {
    const snapshotId = "import_copy_123";
    const snapshotKey = generateJsonShareKey();
    const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({
      title: "Research handoff",
      files: [
        { id: "brief", path: "brief.md", title: "brief.md", text: "# Brief\n" },
        { id: "findings", path: "research/findings.md", title: "findings.md", text: "# Findings\n" },
      ],
      activeFileId: "findings",
      snapshotKey,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    globalThis.fetch = vi.fn(async () => new Response(encrypted, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })) as typeof fetch;

    await withClient(async (client) => {
      const imported = await client.callTool({
        name: "import_copy",
        arguments: { copyUrl: `https://tabula.md/#json=${snapshotId},${snapshotKey}` },
      });
      expect(imported.isError).not.toBe(true);
      expect(imported.structuredContent).toEqual({
        title: "Research handoff",
        files: [
          { path: "brief.md", content: "# Brief\n" },
          { path: "research/findings.md", content: "# Findings\n" },
        ],
        fileCount: 2,
        totalCharacters: 19,
        activePath: "research/findings.md",
        createdAt: "2026-07-17T12:00:00.000Z",
        commentCount: 0,
      });
      expect(JSON.stringify(imported.structuredContent)).not.toContain("#json=");
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^tabula:\/\/session\//)]),
      );
    });
  });

  it("returns an actionable error for a missing or invalid copy key", async () => {
    const snapshotKey = generateJsonShareKey();
    const encrypted = await createEncryptedJsonShareWorkspaceSnapshot({
      files: [{ id: "brief", path: "brief.md", title: "brief.md", text: "# Brief\n" }],
      snapshotKey,
    });
    globalThis.fetch = vi.fn(async () => new Response(encrypted, { status: 200 })) as typeof fetch;

    await withClient(async (client) => {
      const imported = await client.callTool({
        name: "import_copy",
        arguments: { copyUrl: `https://tabula.md/#json=import_copy_123,${generateJsonShareKey()}` },
      });
      expect(imported.isError).toBe(true);
      const error = JSON.parse(imported.content?.find((item) => item.type === "text")?.text ?? "{}");
      expect(error).toMatchObject({
        code: "copy_import_failed",
        details: expect.any(Object),
        message: expect.stringContaining("could not be decrypted"),
        retry: expect.stringContaining("complete #json URL"),
      });
      expect(imported.structuredContent).toEqual(error);
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
        name: "export_copy",
        arguments: {
          title: "Self hosted",
          files: [{ path: "self-hosted.md", content: "# Self hosted\n" }],
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

  it("keeps the same twenty-tool contract in read-only mode", async () => {
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
