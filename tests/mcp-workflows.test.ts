import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabulaDocumentAppResourceUri } from "../src/app/types.js";
import { MemoryDocumentStore } from "../src/documents/store.js";
import { createTabulaMcpServer } from "../src/index.js";
import { roomDocumentResourceUri, roomWorkspaceResourceUri } from "../src/workspace-resources.js";

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const roomClientMock = vi.hoisted(() => {
  const instances: MockRoomClient[] = [];
  let sequence = 0;

  type MockWorkspaceNode = {
    id: string;
    type: "folder" | "document";
    parentId: string | null;
    title: string;
    sha256?: string;
    textLength?: number;
    order?: number;
    createdAt: string;
    updatedAt: string;
  };

  type MockWorkspace = {
    roomId: string;
    mode: "workspace";
    version: number;
    rootId: string;
    nodes: MockWorkspaceNode[];
    activeDocumentId?: string;
  };

  type MockDocument = {
    documentId: string;
    title: string;
    markdown: string;
    parentId?: string | null;
    sha256?: string;
  };

  const fakeSha256 = (text: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(64, "0");
  };

  const nextUuid = () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };

  const documentNodes = (workspace: MockWorkspace | null) =>
    workspace?.nodes.filter((node): node is MockWorkspaceNode & { type: "document" } => node.type === "document") ?? [];

  const applyPatches = (
    markdown: string,
    patches: Array<{ from: number; to: number; insert: string }>,
  ) => {
    let next = markdown;
    for (const patch of [...patches].sort((first, second) => second.from - first.from || second.to - first.to)) {
      if (patch.from < 0 || patch.to < patch.from || patch.to > next.length) {
        throw new Error("Patches for workspace document are outside the current Markdown text.");
      }
      next = `${next.slice(0, patch.from)}${patch.insert}${next.slice(patch.to)}`;
    }
    return next;
  };

  class MockRoomClient {
    readonly sessionId = nextUuid();
    readonly roomId: string;
    readonly roomServerUrl: string;
    readonly shareUrl: string;
    readonly actor: {
      id: string;
      kind: "agent";
      name: string;
      client: "tabula-mcp";
      capabilities: string[];
      color: string;
      joinedAt: string;
    };
    readonly writeAccess: boolean;

    status = "connecting";
    workspace: MockWorkspace | null = null;
    documents = new Map<string, { title: string; markdown: string; sha256: string }>();
    identity: {
      id: string;
      name: string;
      color: string;
      lastSeen: number;
      fileTitle?: string;
      selection?: { documentId?: string; from: number; to: number };
      actor: MockRoomClient["actor"];
    };
    lastChangedDocumentIds: string[] = [];
    disconnected = false;

    constructor({
      parsedRoom,
      roomServerUrl,
      identityName,
      identityColor,
      actorCapabilities,
    }: {
      parsedRoom: { roomId: string; shareUrl: string };
      roomServerUrl: string;
      identityName?: string;
      identityColor?: string;
      actorCapabilities?: readonly string[];
    }) {
      this.roomId = parsedRoom.roomId;
      this.roomServerUrl = roomServerUrl;
      this.shareUrl = parsedRoom.shareUrl;
      this.actor = {
        id: `tabula-mcp-${this.sessionId}`,
        kind: "agent",
        name: identityName?.trim() || "Tabula Agent",
        client: "tabula-mcp",
        capabilities: [...(actorCapabilities ?? ["presence", "read", "write"])],
        color: identityColor?.trim() || "#2563eb",
        joinedAt: new Date("2026-07-10T00:00:00.000Z").toISOString(),
      };
      this.writeAccess = this.actor.capabilities.includes("write");
      this.identity = {
        id: this.actor.id,
        name: this.actor.name,
        color: this.actor.color,
        lastSeen: Date.now(),
        fileTitle: "Live Markdown",
        actor: this.actor,
      };
      instances.push(this);
    }

    async connect() {
      this.status = "connected";
      return "checkpoint-disabled";
    }

    async publishWorkspaceSnapshot({
      workspace,
      documents,
    }: {
      workspace: MockWorkspace;
      documents: readonly MockDocument[];
    }) {
      this.workspace = { ...workspace, nodes: workspace.nodes.map((node) => ({ ...node })) };
      this.documents.clear();
      for (const document of documents) {
        const sha256 = document.sha256 ?? fakeSha256(document.markdown);
        this.documents.set(document.documentId, {
          title: document.title,
          markdown: document.markdown,
          sha256,
        });
      }
      this.lastChangedDocumentIds = documents.map((document) => document.documentId);
      return {
        emittedWorkspace: true,
        emittedDocumentCount: documents.length,
        checkpointStatus: {
          enabled: false,
          store: "none",
          status: "disabled",
        },
      };
    }

    async getStatus() {
      const activeMarkdown = this.activeMarkdown();
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        shareUrl: this.shareUrl,
        roomServerUrl: this.roomServerUrl,
        status: this.status,
        writeAccess: this.writeAccess,
        actor: this.actor,
        capabilities: this.actor.capabilities,
        textLength: activeMarkdown.length,
        sha256: fakeSha256(activeMarkdown),
        socketConnected: this.status === "connected",
        hydrationStatus: this.workspace ? "ready" : "waiting-for-peer-state",
        stateReceived: Boolean(this.workspace),
        peerCount: 1,
        collaborators: [],
        workspaceMode: Boolean(this.workspace),
        activeDocumentId: this.workspace?.activeDocumentId,
        workspaceVersion: this.workspace?.version,
        checkpointStatus: {
          enabled: false,
          store: "none",
          status: "disabled",
        },
        metadata: null,
      };
    }

    async readMarkdown() {
      const markdown = this.activeMarkdown();
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        markdown,
        textLength: markdown.length,
        sha256: fakeSha256(markdown),
        hydrationStatus: this.workspace ? "ready" : "waiting-for-peer-state",
        stateReceived: Boolean(this.workspace),
      };
    }

    async getOutline() {
      const markdown = this.activeMarkdown();
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        outline: markdown
          .split("\n")
          .flatMap((line, index) => {
            const match = /^(#{1,6})\s+(.+)$/.exec(line);
            return match ? [{ level: match[1]?.length ?? 1, title: match[2], line: index + 1 }] : [];
          }),
        sha256: fakeSha256(markdown),
        hydrationStatus: this.workspace ? "ready" : "waiting-for-peer-state",
        stateReceived: Boolean(this.workspace),
      };
    }

    async readWorkspace() {
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        workspace: this.workspace,
        activeDocumentId: this.workspace?.activeDocumentId,
        documents: documentNodes(this.workspace).map((node) => ({
          ...node,
          cached: this.documents.has(node.id),
        })),
        cachedDocumentCount: this.documents.size,
        hydrationStatus: this.workspace ? "ready" : "waiting-for-peer-state",
        stateReceived: Boolean(this.workspace),
      };
    }

    async readWorkspaceDocument({ documentId }: { documentId: string }) {
      const node = documentNodes(this.workspace).find((candidate) => candidate.id === documentId);
      const cached = this.documents.get(documentId);
      if (!node || !cached) {
        throw new Error("Workspace document text has not been received by this MCP session yet.");
      }
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        documentId,
        title: node.title,
        markdown: cached.markdown,
        textLength: cached.markdown.length,
        sha256: cached.sha256,
        cachedAt: new Date("2026-07-10T00:00:00.000Z").toISOString(),
        hydrationStatus: "ready",
        stateReceived: true,
      };
    }

    async applyWorkspaceChanges({
      changes,
    }: {
      changes: Array<
        | { type: "document.patch"; documentId: string; baseSha256: string; patches: Array<{ from: number; to: number; insert: string }> }
        | { type: "document.create"; parentId: string | null; title: string; markdown: string }
        | { type: "document.rename"; documentId: string; title: string }
        | { type: "document.move"; documentId: string; parentId: string | null }
        | { type: "document.delete"; documentId: string; baseSha256?: string }
      >;
    }) {
      if (!this.workspace) {
        throw new Error("Workspace state has not been received yet.");
      }
      const changedDocumentIds = new Set<string>();

      for (const change of changes) {
        if (change.type === "document.patch") {
          const cached = this.documents.get(change.documentId);
          if (!cached) {
            throw new Error("Workspace document text has not been received by this MCP session yet.");
          }
          if (cached.sha256 !== change.baseSha256) {
            throw new Error("Base hash for workspace document does not match the current cached text.");
          }
          const markdown = applyPatches(cached.markdown, change.patches);
          const sha256 = fakeSha256(markdown);
          this.documents.set(change.documentId, { ...cached, markdown, sha256 });
          this.workspace.nodes = this.workspace.nodes.map((node) =>
            node.id === change.documentId ? { ...node, sha256, textLength: markdown.length } : node,
          );
          changedDocumentIds.add(change.documentId);
          continue;
        }

        if (change.type === "document.create") {
          const documentId = `doc_${nextUuid()}`;
          const now = new Date("2026-07-10T00:00:00.000Z").toISOString();
          const sha256 = fakeSha256(change.markdown);
          this.workspace.nodes.push({
            id: documentId,
            type: "document",
            parentId: change.parentId,
            title: change.title,
            sha256,
            textLength: change.markdown.length,
            order: this.workspace.nodes.length,
            createdAt: now,
            updatedAt: now,
          });
          this.documents.set(documentId, {
            title: change.title,
            markdown: change.markdown,
            sha256,
          });
          changedDocumentIds.add(documentId);
          continue;
        }

        if (change.type === "document.rename") {
          this.workspace.nodes = this.workspace.nodes.map((node) =>
            node.id === change.documentId ? { ...node, title: change.title } : node,
          );
          const cached = this.documents.get(change.documentId);
          if (cached) {
            this.documents.set(change.documentId, { ...cached, title: change.title });
          }
          changedDocumentIds.add(change.documentId);
          continue;
        }

        if (change.type === "document.move") {
          this.workspace.nodes = this.workspace.nodes.map((node) =>
            node.id === change.documentId ? { ...node, parentId: change.parentId } : node,
          );
          changedDocumentIds.add(change.documentId);
          continue;
        }

        this.workspace.nodes = this.workspace.nodes.filter((node) => node.id !== change.documentId);
        this.documents.delete(change.documentId);
        changedDocumentIds.add(change.documentId);
      }

      this.workspace.version += 1;
      this.lastChangedDocumentIds = [...changedDocumentIds];
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        applied: true,
        changes,
        changedDocumentIds: this.lastChangedDocumentIds,
        workspace: this.workspace,
        documents: documentNodes(this.workspace).map((node) => ({
          documentId: node.id,
          title: node.title,
          sha256: node.sha256,
          textLength: node.textLength,
          cached: this.documents.has(node.id),
        })),
      };
    }

    async setPresence(selection?: { documentId?: string; from: number; to: number }, fileTitle?: string) {
      this.identity = {
        ...this.identity,
        fileTitle: fileTitle?.trim() || this.identity.fileTitle,
        selection,
        lastSeen: Date.now(),
      };
      return {
        sessionId: this.sessionId,
        roomId: this.roomId,
        identity: this.identity,
      };
    }

    async waitForChange() {
      const markdown = this.activeMarkdown();
      return {
        changed: this.lastChangedDocumentIds.length > 0,
        markdown,
        sha256: fakeSha256(markdown),
        activeDocumentId: this.workspace?.activeDocumentId,
        workspace: this.workspace,
        documents: documentNodes(this.workspace).map((node) => ({
          documentId: node.id,
          title: node.title,
          sha256: node.sha256 ?? fakeSha256(this.documents.get(node.id)?.markdown ?? ""),
          textLength: node.textLength ?? 0,
          cached: this.documents.has(node.id),
        })),
        changedDocumentIds: this.lastChangedDocumentIds,
        checkpointStatus: {
          enabled: false,
          store: "none",
          status: "disabled",
        },
        hydrationStatus: this.workspace ? "ready" : "waiting-for-peer-state",
        stateReceived: Boolean(this.workspace),
      };
    }

    disconnect() {
      this.status = "closed";
      this.disconnected = true;
    }

    private activeMarkdown() {
      const activeDocumentId = this.workspace?.activeDocumentId;
      return activeDocumentId ? this.documents.get(activeDocumentId)?.markdown ?? "" : "";
    }
  }

  return {
    instances,
    reset() {
      instances.splice(0);
      sequence = 0;
    },
    MockRoomClient,
  };
});

vi.mock("../src/room-client.js", () => ({
  TabulaRoomClient: roomClientMock.MockRoomClient,
}));

const originalFetch = globalThis.fetch;

const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const modelFacingTools = [
  "tabula_read_me",
  "tabula_create_workspace",
  "tabula_import_markdown_workspace",
  "tabula_share_workspace",
  "tabula_create_workspace_room",
  "tabula_connect_room",
  "tabula_list_sessions",
  "tabula_room_status",
  "tabula_read_workspace",
  "tabula_read_workspace_document",
  "tabula_read_workspace_context",
  "tabula_apply_workspace_changes",
  "tabula_set_presence",
  "tabula_wait_for_changes",
  "tabula_disconnect_room",
] as const;

const appTools = [
  "tabula_create_document",
  "tabula_list_documents",
  "tabula_open_document",
  "tabula_share_document",
  "tabula_open_room_view",
  "tabula_app_room_snapshot",
  "tabula_app_document_snapshot",
  "tabula_app_save_document",
] as const;

const withClient = async <T>(
  callback: (client: Client) => Promise<T>,
  options: { mcpApps?: boolean; writeEnabled?: boolean; env?: Record<string, string | undefined> } = {},
) => {
  const { server, registry, workspaces, documents } = createTabulaMcpServer({
    writeEnabled: options.writeEnabled ?? false,
    documentStore: new MemoryDocumentStore(),
    env: options.env ?? {},
  });
  const client = new Client(
    { name: "tabula-mcp-workflow-test", version: "0.0.0" },
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

const callTool = async <T>(
  client: Client,
  calledTools: Set<string>,
  name: string,
  args: Record<string, unknown> = {},
) => {
  calledTools.add(name);
  const result = await client.callTool({
    name,
    arguments: args,
  });
  expect(result.isError, name).not.toBe(true);
  expect(result.structuredContent, name).toBeDefined();
  return result as ToolCallResult & { structuredContent: T };
};

const textContent = (result: ToolCallResult) =>
  result.content?.find((item) => item.type === "text")?.text ?? "";

const roomKey = () => Buffer.from(new Uint8Array(32).fill(17)).toString("base64url");

beforeEach(() => {
  roomClientMock.reset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("MCP end-to-end tool workflows", () => {
  it("exercises every model-facing workspace, share, room, resource, and session tool", async () => {
    const snapshotIds = ["workspace_snapshot_1"];
    const fetchMock = vi.fn(async () => {
      const id = snapshotIds.shift() ?? "workspace_snapshot_fallback";
      return new Response(JSON.stringify({ id, data: `https://json.tabula.md/api/v2/${id}` }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await withClient(async (client) => {
      const calledTools = new Set<string>();
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(modelFacingTools.every((tool) => toolNames.includes(tool))).toBe(true);
      expect(appTools.some((tool) => toolNames.includes(tool))).toBe(false);

      const readMe = await callTool<{ readMe: { topic: string; securityRules: string[] } }>(
        client,
        calledTools,
        "tabula_read_me",
        { topic: "rooms" },
      );
      expect(readMe.structuredContent.readMe.securityRules.join("\n")).toContain("#room");

      const created = await callTool<{
        workspaceId: string;
        resourceUri: string;
        documents: Array<{ id: string; title: string; path?: string; sha256: string; resourceUri: string }>;
        workspaceSummary: { documentCount: number };
      }>(client, calledTools, "tabula_create_workspace", {
        title: "Workflow Docs",
        files: [
          { path: "README.md", markdown: "# Workflow Docs\n\nStart here.\n" },
          { path: "docs/Guide.md", markdown: "# Guide\n\nRead this guide.\n" },
          { path: "archive/Old.md", markdown: "# Old\n\nRemove this later.\n" },
        ],
      });
      expect(created.structuredContent.workspaceSummary.documentCount).toBe(3);

      const imported = await callTool<{ workspaceId: string; source: string; cachedDocumentCount: number }>(
        client,
        calledTools,
        "tabula_import_markdown_workspace",
        {
          title: "Imported Inline Docs",
          source: {
            type: "files",
            files: [{ path: "notes/Imported.md", markdown: "# Imported\n" }],
          },
        },
      );
      expect(imported.structuredContent).toMatchObject({
        source: "imported",
        cachedDocumentCount: 1,
      });

      const tree = await callTool<{
        workspaceId: string;
        workspace: { rootId: string; activeDocumentId: string; nodes: Array<{ id: string; type: string; title: string }> };
        documents: Array<{ id: string; title: string; path?: string; sha256: string; resourceUri: string }>;
      }>(client, calledTools, "tabula_read_workspace", {
        workspaceId: created.structuredContent.workspaceId,
        detail: "tree",
      });
      const readme = tree.structuredContent.documents.find((document) => document.path === "README.md");
      const guide = tree.structuredContent.documents.find((document) => document.path === "docs/Guide.md");
      const old = tree.structuredContent.documents.find((document) => document.path === "archive/Old.md");
      expect(readme).toBeDefined();
      expect(guide).toBeDefined();
      expect(old).toBeDefined();

      const readmeDocument = await callTool<{
        workspaceId: string;
        documentId: string;
        markdown: string;
        sha256: string;
        resourceUri: string;
      }>(client, calledTools, "tabula_read_workspace_document", {
        workspaceId: created.structuredContent.workspaceId,
        documentId: readme?.id,
      });
      expect(readmeDocument.structuredContent.markdown).toContain("Start here.");

      const context = await callTool<{ matchedDocumentCount: number; documents: Array<{ selectionReasons: string[] }> }>(
        client,
        calledTools,
        "tabula_read_workspace_context",
        {
          workspaceId: created.structuredContent.workspaceId,
          pathGlobs: ["docs/*"],
          query: "Read this guide",
          changedSince: { [guide?.id ?? ""]: "0".repeat(64) },
          maxDocuments: 2,
          maxCharsPerDocument: 500,
          maxTotalChars: 1_000,
        },
      );
      expect(context.structuredContent).toMatchObject({
        matchedDocumentCount: 1,
      });
      expect(context.structuredContent.documents[0]?.selectionReasons).toEqual(
        expect.arrayContaining(["path-glob", "query-markdown", "changed-since"]),
      );

      const resources = await client.listResources();
      expect(resources.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uri: created.structuredContent.resourceUri, mimeType: "application/json" }),
          expect.objectContaining({ uri: readmeDocument.structuredContent.resourceUri, mimeType: "text/markdown" }),
        ]),
      );
      const readmeResource = await client.readResource({ uri: readmeDocument.structuredContent.resourceUri });
      expect(readmeResource.contents[0]).toMatchObject({
        mimeType: "text/markdown",
        text: "# Workflow Docs\n\nStart here.\n",
      });

      const share = await callTool<{ share: { snapshotId: string; shareUrl: string; fileCount: number } }>(
        client,
        calledTools,
        "tabula_share_workspace",
        { workspaceId: created.structuredContent.workspaceId },
      );
      expect(share.structuredContent.share).toMatchObject({
        snapshotId: "workspace_snapshot_1",
        fileCount: 3,
      });
      expect(share.structuredContent.share.shareUrl).toMatch(/^https:\/\/tabula\.md\/#json=workspace_snapshot_1,/);
      const uploadBody = Buffer.from((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as ArrayBuffer).toString("utf8");
      expect(uploadBody).not.toContain("Workflow Docs");
      expect(uploadBody).not.toContain(new URL(share.structuredContent.share.shareUrl).hash.split(",")[1] ?? "");

      const room = await callTool<{
        sessionId: string;
        roomId: string;
        roomUrl: string;
        actor: { kind: string; name: string; capabilities: string[] };
        published: { emittedWorkspace: boolean; emittedDocumentCount: number };
      }>(client, calledTools, "tabula_create_workspace_room", {
        workspaceId: created.structuredContent.workspaceId,
        appOrigin: "http://127.0.0.1:5173",
        identityName: "Workflow Agent",
        identityColor: "#0f766e",
      });
      expect(room.structuredContent.actor).toMatchObject({
        kind: "agent",
        name: "Workflow Agent",
      });
      expect(room.structuredContent.actor.capabilities).toEqual(
        ["presence", "read", "write"],
      );
      expect(room.structuredContent.published).toMatchObject({
        emittedWorkspace: true,
        emittedDocumentCount: 3,
      });
      expect(room.structuredContent.roomUrl).toMatch(/^http:\/\/127\.0\.0\.1:5173\/#room=/);

      const sessions = await callTool<{ sessions: Array<{ sessionId: string; roomId: string }> }>(
        client,
        calledTools,
        "tabula_list_sessions",
      );
      expect(sessions.structuredContent.sessions).toEqual([
        expect.objectContaining({
          sessionId: room.structuredContent.sessionId,
          roomId: room.structuredContent.roomId,
        }),
      ]);

      const status = await callTool<{ sessionId: string; hydrationStatus: string; stateReceived: boolean }>(
        client,
        calledTools,
        "tabula_room_status",
        { sessionId: room.structuredContent.sessionId },
      );
      expect(status.structuredContent).toMatchObject({
        hydrationStatus: "ready",
        stateReceived: true,
      });

      const roomWorkspace = await callTool<{
        sessionId: string;
        resourceUri: string;
        documents: Array<{ id: string; title: string; sha256: string; cached: boolean; resourceUri: string }>;
      }>(client, calledTools, "tabula_read_workspace", {
        sessionId: room.structuredContent.sessionId,
        detail: "tree",
      });
      expect(roomWorkspace.structuredContent.resourceUri).toBe(roomWorkspaceResourceUri(room.structuredContent.sessionId));
      const roomReadme = roomWorkspace.structuredContent.documents.find((document) => document.title === "README.md");
      const roomGuide = roomWorkspace.structuredContent.documents.find((document) => document.title === "Guide.md");
      const roomOld = roomWorkspace.structuredContent.documents.find((document) => document.title === "Old.md");
      expect(roomReadme).toBeDefined();
      expect(roomGuide).toBeDefined();
      expect(roomOld).toBeDefined();

      const roomReadmeDocument = await callTool<{ documentId: string; markdown: string; sha256: string; resourceUri: string }>(
        client,
        calledTools,
        "tabula_read_workspace_document",
        {
          sessionId: room.structuredContent.sessionId,
          documentId: roomReadme?.id,
        },
      );
      expect(roomReadmeDocument.structuredContent.resourceUri).toBe(
        roomDocumentResourceUri(room.structuredContent.sessionId, roomReadme?.id ?? ""),
      );

      const presence = await callTool<{ identity: { fileTitle: string; selection: { documentId: string; from: number; to: number } } }>(
        client,
        calledTools,
        "tabula_set_presence",
        {
          sessionId: room.structuredContent.sessionId,
          fileTitle: "README.md",
          selection: {
            documentId: roomReadme?.id,
            from: 0,
            to: 10,
          },
        },
      );
      expect(presence.structuredContent.identity).toMatchObject({
        fileTitle: "README.md",
        selection: {
          documentId: roomReadme?.id,
          from: 0,
          to: 10,
        },
      });

      const apply = await callTool<{
        applied: boolean;
        changedDocumentIds: string[];
        workspace: { nodes: Array<{ id: string; title: string; parentId: string | null }> };
      }>(client, calledTools, "tabula_apply_workspace_changes", {
        sessionId: room.structuredContent.sessionId,
        changes: [
          {
            type: "document.patch",
            documentId: roomReadme?.id,
            baseSha256: roomReadmeDocument.structuredContent.sha256,
            patches: [{ from: roomReadmeDocument.structuredContent.markdown.length, to: roomReadmeDocument.structuredContent.markdown.length, insert: "\nAgent edit.\n" }],
          },
          {
            type: "document.create",
            parentId: tree.structuredContent.workspace.rootId,
            title: "Agent Notes.md",
            markdown: "# Agent Notes\n\nCreated by MCP.\n",
          },
          {
            type: "document.rename",
            documentId: roomGuide?.id,
            title: "Guide Revised.md",
          },
          {
            type: "document.move",
            documentId: roomGuide?.id,
            parentId: null,
          },
          {
            type: "document.delete",
            documentId: roomOld?.id,
          },
        ],
      });
      expect(apply.structuredContent).toMatchObject({
        applied: true,
      });
      expect(apply.structuredContent.workspace.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Guide Revised.md", parentId: null }),
          expect.objectContaining({ title: "Agent Notes.md" }),
        ]),
      );
      expect(apply.structuredContent.workspace.nodes).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ title: "Old.md" })]),
      );

      const wait = await callTool<{ changed: boolean; markdownIncluded: boolean; changedDocumentIds: string[] }>(
        client,
        calledTools,
        "tabula_wait_for_changes",
        {
          sessionId: room.structuredContent.sessionId,
          sinceSha256: roomReadmeDocument.structuredContent.sha256,
          timeoutMs: 0,
        },
      );
      expect(wait.structuredContent).toMatchObject({
        changed: true,
        markdownIncluded: false,
      });
      expect(wait.structuredContent.changedDocumentIds.length).toBeGreaterThan(0);

      const roomContext = await callTool<{ matchedDocumentCount: number; documents: Array<{ markdownExcerpt: string }> }>(
        client,
        calledTools,
        "tabula_read_workspace_context",
        {
          sessionId: room.structuredContent.sessionId,
          query: "Agent",
          maxDocuments: 5,
          maxCharsPerDocument: 1_000,
          maxTotalChars: 2_000,
        },
      );
      expect(roomContext.structuredContent.matchedDocumentCount).toBeGreaterThanOrEqual(1);
      expect(roomContext.structuredContent.documents.map((document) => document.markdownExcerpt).join("\n")).toContain("Agent");

      const external = await callTool<{ sessionId: string; roomId: string; recoveryStatus: string }>(
        client,
        calledTools,
        "tabula_connect_room",
        {
          roomUrl: `https://tabula.md/#room=external-room,${roomKey()}`,
          identityName: "External Agent",
        },
      );
      expect(external.structuredContent).toMatchObject({
        roomId: "external-room",
        recoveryStatus: "checkpoint-disabled",
      });

      const disconnectExternal = await callTool<{ disconnectedSessionId: string }>(
        client,
        calledTools,
        "tabula_disconnect_room",
        { sessionId: external.structuredContent.sessionId },
      );
      expect(disconnectExternal.structuredContent.disconnectedSessionId).toBe(external.structuredContent.sessionId);

      const disconnectCreatedRoom = await callTool<{ disconnectedSessionId: string }>(
        client,
        calledTools,
        "tabula_disconnect_room",
        { sessionId: room.structuredContent.sessionId },
      );
      expect(disconnectCreatedRoom.structuredContent.disconnectedSessionId).toBe(room.structuredContent.sessionId);

      const emptySessions = await callTool<{ sessions: unknown[] }>(client, calledTools, "tabula_list_sessions");
      expect(emptySessions.structuredContent.sessions).toEqual([]);
      expect([...calledTools].sort()).toEqual([...modelFacingTools].sort());
    });
  });

  it("exercises every MCP App document and room-view tool for app-capable clients", async () => {
    const fetchMock = vi.fn(async () => {
      const id = "document_snapshot_1";
      return new Response(JSON.stringify({ id, data: `https://json.tabula.md/api/v2/${id}` }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await withClient(
      async (client) => {
        const calledTools = new Set<string>();
        const tools = await client.listTools();
        const toolNames = tools.tools.map((tool) => tool.name);
        expect(appTools.every((tool) => toolNames.includes(tool))).toBe(true);

        const document = await callTool<{
          document: { documentId: string; title: string; sha256: string; outlineCount: number };
          markdown: string;
          resourceUri: string;
        }>(client, calledTools, "tabula_create_document", {
          title: "App Draft",
          markdown: "# App Draft\n\nInitial body.\n",
        });
        expect(document.structuredContent).toMatchObject({
          document: {
            title: "App Draft",
            outlineCount: 1,
          },
          resourceUri: tabulaDocumentAppResourceUri,
        });

        const listed = await callTool<{ documents: Array<{ documentId: string; title: string }> }>(
          client,
          calledTools,
          "tabula_list_documents",
        );
        expect(listed.structuredContent.documents).toEqual([
          expect.objectContaining({
            documentId: document.structuredContent.document.documentId,
            title: "App Draft",
          }),
        ]);

        const opened = await callTool<{ document: { documentId: string }; markdown: string }>(
          client,
          calledTools,
          "tabula_open_document",
          { documentId: document.structuredContent.document.documentId },
        );
        expect(opened.structuredContent.markdown).toBe("# App Draft\n\nInitial body.\n");

        const saved = await callTool<{ document: { documentId: string; title: string; sha256: string }; markdown: string }>(
          client,
          calledTools,
          "tabula_app_save_document",
          {
            documentId: document.structuredContent.document.documentId,
            title: "App Draft Revised",
            markdown: "# App Draft Revised\n\nSaved body.\n",
          },
        );
        expect(saved.structuredContent.document.sha256).not.toBe(document.structuredContent.document.sha256);
        expect(saved.structuredContent.markdown).toBe("# App Draft Revised\n\nSaved body.\n");

        const snapshot = await callTool<{ document: { documentId: string; title: string }; markdown: string }>(
          client,
          calledTools,
          "tabula_app_document_snapshot",
          { documentId: document.structuredContent.document.documentId },
        );
        expect(snapshot.structuredContent).toMatchObject({
          document: {
            documentId: document.structuredContent.document.documentId,
            title: "App Draft Revised",
          },
          markdown: "# App Draft Revised\n\nSaved body.\n",
        });

        const shared = await callTool<{ share: { snapshotId: string; shareUrl: string; encrypted: boolean } }>(
          client,
          calledTools,
          "tabula_share_document",
          { documentId: document.structuredContent.document.documentId },
        );
        expect(shared.structuredContent.share).toMatchObject({
          snapshotId: "document_snapshot_1",
          encrypted: true,
        });
        const body = Buffer.from((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as ArrayBuffer).toString("utf8");
        expect(body).not.toContain("Saved body");
        expect(body).not.toContain(new URL(shared.structuredContent.share.shareUrl).hash.split(",")[1] ?? "");

        const workspace = await callTool<{ workspaceId: string; documents: Array<{ id: string }> }>(
          client,
          calledTools,
          "tabula_create_workspace",
          {
            title: "Room View Workspace",
            files: [{ path: "README.md", markdown: "# Room View\n\nVisible in the app.\n" }],
          },
        );
        const room = await callTool<{ sessionId: string; roomId: string }>(
          client,
          calledTools,
          "tabula_create_workspace_room",
          {
            workspaceId: workspace.structuredContent.workspaceId,
            appOrigin: "http://127.0.0.1:5173",
          },
        );

        const roomView = await callTool<{ mode: string; room: { sessionId: string; hydrationStatus: string } }>(
          client,
          calledTools,
          "tabula_open_room_view",
          { sessionId: room.structuredContent.sessionId },
        );
        expect(roomView.structuredContent).toMatchObject({
          mode: "room",
          room: {
            sessionId: room.structuredContent.sessionId,
            hydrationStatus: "ready",
          },
        });

        const roomSnapshot = await callTool<{ mode: string; room: { roomId: string }; markdown: string; outline: unknown[] }>(
          client,
          calledTools,
          "tabula_app_room_snapshot",
          { sessionId: room.structuredContent.sessionId },
        );
        expect(roomSnapshot.structuredContent).toMatchObject({
          mode: "room",
          room: {
            roomId: room.structuredContent.roomId,
          },
          markdown: "# Room View\n\nVisible in the app.\n",
        });
        expect(roomSnapshot.structuredContent.outline.length).toBe(1);

        const appResource = await client.readResource({ uri: tabulaDocumentAppResourceUri });
        expect(appResource.contents[0]).toMatchObject({
          uri: tabulaDocumentAppResourceUri,
          mimeType: "text/html;profile=mcp-app",
        });
        expect(textContent(roomView)).toContain("Opening Tabula Room View");
        expect([...calledTools].filter((tool) => appTools.includes(tool as (typeof appTools)[number])).sort()).toEqual(
          [...appTools].sort(),
        );
      },
      { mcpApps: true },
    );
  });
});
