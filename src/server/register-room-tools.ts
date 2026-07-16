import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertLocalImportRootAllowed } from "../import-roots.js";
import { jsonContent, errorContent } from "../json.js";
import { parseRoomShareUrl, resolveRoomServerUrl } from "../protocol.js";
import type { SessionRegistry } from "../registry.js";
import type { RuntimeEnvironment } from "../env.js";
import { createFirebaseWorkspaceRoomCheckpointStore } from "../room-checkpoints.js";
import { TabulaRoomClient } from "../room-client.js";
import { shareMarkdownWorkspace } from "../share.js";
import { startWorkspaceRoom } from "../room-session.js";
import { addWorkspaceDocumentResourceUri, addWorkspaceResourceUris } from "../workspace-resources.js";
import {
  readStoredWorkspace,
  readStoredWorkspaceDocument,
  workspaceShareFiles,
  type WorkspaceRegistry,
} from "../workspaces.js";

const optionalSessionSchema = {
  sessionId: z.string().uuid().optional().describe("Session id returned by tabula_connect_room. Defaults to the latest session."),
};

const optionalWorkspaceSchema = {
  workspaceId: z.string().uuid().optional().describe("Workspace id returned by tabula_create_workspace or tabula_import_markdown_workspace."),
};

const optionalWorkspaceOrSessionSchema = {
  ...optionalSessionSchema,
  ...optionalWorkspaceSchema,
};

const workspaceDetailSchema = z
  .enum(["summary", "tree"])
  .default("summary")
  .describe("Use summary by default; pass tree only when folder/node structure is needed.");

const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 hex value returned by tabula_read_workspace_document or tabula_room_status.");

const workspaceFileInputSchema = z.object({
  path: z.string().min(1).describe("Workspace-relative Markdown path, for example docs/README.md."),
  title: z.string().min(1).max(200).optional().describe("Optional display title. Defaults to the file basename."),
  markdown: z.string().describe("Markdown content for this workspace document."),
});

const textPatchInputSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  insert: z.string(),
});

const workspaceChangeInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("document.patch"),
    documentId: z.string().min(1),
    baseSha256: sha256HexSchema,
    patches: z.array(textPatchInputSchema).min(1),
  }),
  z.object({
    type: z.literal("document.create"),
    parentId: z.string().min(1).nullable(),
    title: z.string().min(1).max(200),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal("document.rename"),
    documentId: z.string().min(1),
    title: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("document.move"),
    documentId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("document.delete"),
    documentId: z.string().min(1),
    baseSha256: sha256HexSchema.optional(),
  }),
]);

type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

const runTool = async (handler: () => Promise<unknown>) => {
  try {
    return jsonContent(await handler());
  } catch (error) {
    return errorContent(error);
  }
};

const compactWorkspaceResult = <T extends { workspace?: unknown; activeDocumentId?: string; documents?: unknown[]; note?: string }>(
  value: T,
  detail: WorkspaceDetail,
) => {
  if (detail === "tree" || !value.workspace || typeof value.workspace !== "object") {
    return value;
  }

  const workspace = value.workspace as {
    roomId?: string;
    mode?: string;
    version?: number;
    rootId?: string;
    activeDocumentId?: string;
    nodes?: Array<{ type?: string }>;
  };
  const nodes = Array.isArray(workspace.nodes) ? workspace.nodes : [];
  const documentCount = nodes.filter((node) => node.type === "document").length;
  const folderCount = nodes.filter((node) => node.type === "folder").length;

  return {
    ...value,
    workspace: null,
    workspaceSummary: {
      roomId: workspace.roomId,
      mode: workspace.mode,
      version: workspace.version,
      rootId: workspace.rootId,
      activeDocumentId: workspace.activeDocumentId ?? value.activeDocumentId,
      nodeCount: nodes.length,
      folderCount,
      documentCount,
    },
    omittedWorkspaceNodeCount: nodes.length,
    note: value.note ?? 'Workspace tree omitted to keep context small. Call tabula_read_workspace with detail="tree" if needed.',
  };
};

const excerptMarkdown = (markdown: string, maxChars: number) => {
  const limit = Math.max(0, maxChars);
  if (markdown.length <= limit) {
    return {
      markdownExcerpt: markdown,
      includedChars: markdown.length,
      truncated: false,
    };
  }

  return {
    markdownExcerpt: markdown.slice(0, limit),
    includedChars: limit,
    truncated: true,
  };
};

const globToRegExp = (glob: string) => {
  const escaped = glob
    .trim()
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`, "i");
};

const matchesPathGlob = (value: string | undefined, patterns: readonly RegExp[]) =>
  Boolean(value && patterns.some((pattern) => pattern.test(value.replaceAll("\\", "/"))));

const normalizeQuery = (query: string | undefined) => query?.trim().toLowerCase() || "";

const readWorkspaceFromSelector = async (
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
  { sessionId, workspaceId }: { sessionId?: string; workspaceId?: string },
) => {
  if (workspaceId) {
    return readStoredWorkspace(workspaces.get(workspaceId));
  }
  if (sessionId) {
    return registry.get(sessionId).readWorkspace();
  }
  if (workspaces.has()) {
    return readStoredWorkspace(workspaces.get());
  }
  return registry.get().readWorkspace();
};

const readWorkspaceDocumentFromSelector = async (
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
  { sessionId, workspaceId, documentId }: { sessionId?: string; workspaceId?: string; documentId: string },
) => {
  if (workspaceId) {
    return readStoredWorkspaceDocument(workspaces.get(workspaceId), documentId);
  }
  if (sessionId) {
    return registry.get(sessionId).readWorkspaceDocument({ documentId });
  }
  if (workspaces.has()) {
    return readStoredWorkspaceDocument(workspaces.get(), documentId);
  }
  return registry.get().readWorkspaceDocument({ documentId });
};

const readWorkspaceContextFromSelector = async (
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
  {
    sessionId,
    workspaceId,
    documentIds,
    pathGlobs,
    query,
    changedSince,
    maxDocuments,
    maxCharsPerDocument,
    maxTotalChars,
  }: {
    sessionId?: string;
    workspaceId?: string;
    documentIds?: string[];
    pathGlobs?: string[];
    query?: string;
    changedSince?: Record<string, string>;
    maxDocuments: number;
    maxCharsPerDocument: number;
    maxTotalChars: number;
  },
) => {
  const workspace = await readWorkspaceFromSelector(registry, workspaces, { sessionId, workspaceId });
  const requestedIds = documentIds?.length ? new Set(documentIds) : null;
  const pathMatchers = (pathGlobs ?? []).map(globToRegExp);
  const normalizedQuery = normalizeQuery(query);
  const documents = [];
  const skippedDocuments: Array<{ documentId: string; reason: string }> = [];
  let totalIncludedChars = 0;
  let budgetExhausted = false;

  for (const documentId of requestedIds ?? []) {
    if (!workspace.documents.some((document) => document.id === documentId)) {
      skippedDocuments.push({ documentId, reason: "document-not-found" });
    }
  }

  for (const summary of workspace.documents) {
    if (documents.length >= maxDocuments) {
      break;
    }
    if (totalIncludedChars >= maxTotalChars) {
      budgetExhausted = true;
      break;
    }

    const documentId = summary.id;
    const pathValue = "path" in summary ? summary.path : undefined;
    if (requestedIds && !requestedIds.has(documentId)) {
      continue;
    }
    if (pathMatchers.length > 0 && !matchesPathGlob(pathValue, pathMatchers) && !matchesPathGlob(summary.title, pathMatchers)) {
      continue;
    }
    if (changedSince && changedSince[documentId] === summary.sha256) {
      continue;
    }
    if (!summary.cached) {
      skippedDocuments.push({ documentId, reason: "document-not-cached" });
      continue;
    }

    try {
      const document = await readWorkspaceDocumentFromSelector(registry, workspaces, { sessionId, workspaceId, documentId });
      const metadataHaystack = `${"path" in document && document.path ? document.path : ""}\n${document.title}`.toLowerCase();
      const queryMatchedMetadata = normalizedQuery ? metadataHaystack.includes(normalizedQuery) : false;
      const queryMatchedMarkdown = normalizedQuery ? document.markdown.toLowerCase().includes(normalizedQuery) : false;
      if (normalizedQuery && !queryMatchedMetadata && !queryMatchedMarkdown) {
        continue;
      }

      const selectionReasons: string[] = [];
      if (requestedIds?.has(documentId)) {
        selectionReasons.push("document-id");
      }
      if (pathMatchers.length > 0) {
        selectionReasons.push("path-glob");
      }
      if (changedSince && changedSince[documentId] !== summary.sha256) {
        selectionReasons.push("changed-since");
      }
      if (queryMatchedMetadata) {
        selectionReasons.push("query-metadata");
      } else if (queryMatchedMarkdown) {
        selectionReasons.push("query-markdown");
      }
      if (selectionReasons.length === 0) {
        selectionReasons.push("default");
      }

      const remainingChars = Math.max(0, maxTotalChars - totalIncludedChars);
      if (remainingChars === 0) {
        budgetExhausted = true;
        break;
      }
      const excerpt = excerptMarkdown(document.markdown, Math.min(maxCharsPerDocument, remainingChars));
      totalIncludedChars += excerpt.includedChars;
      if (excerpt.truncated || totalIncludedChars >= maxTotalChars) {
        budgetExhausted = totalIncludedChars >= maxTotalChars;
      }

      documents.push({
        documentId: document.documentId,
        ...("path" in document && document.path ? { path: document.path } : {}),
        title: document.title,
        sha256: document.sha256,
        textLength: document.textLength,
        selectionReasons,
        ...excerpt,
      });
    } catch (error) {
      skippedDocuments.push({
        documentId,
        reason: error instanceof Error ? error.message : "document-read-failed",
      });
    }
  }

  return {
    ...("sessionId" in workspace ? { sessionId: workspace.sessionId } : {}),
    ...("workspaceId" in workspace ? { workspaceId: workspace.workspaceId } : {}),
    roomId: workspace.roomId,
    documents,
    skippedDocuments,
    totalIncludedChars,
    truncatedDocumentCount: documents.filter((document) => document.truncated).length,
    matchedDocumentCount: documents.length,
    totalBudgetChars: maxTotalChars,
    budgetExhausted,
    hydrationStatus: workspace.hydrationStatus,
    stateReceived: workspace.stateReceived,
    ...("lastStateReceivedAt" in workspace && workspace.lastStateReceivedAt
      ? { lastStateReceivedAt: workspace.lastStateReceivedAt }
      : {}),
    note:
      skippedDocuments.length > 0
        ? "Some workspace documents were not included. Use tabula_read_workspace_document for exact full text when needed."
        : "This is a bounded context excerpt. Use tabula_read_workspace_document for exact full text when needed.",
  };
};

export const registerRoomTools = (
  server: McpServer,
  registry: SessionRegistry,
  workspaces: WorkspaceRegistry,
  { env, writeEnabled, allowTemporaryRooms = true }: { env?: RuntimeEnvironment; writeEnabled: boolean; allowTemporaryRooms?: boolean },
) => {
  server.registerTool(
    "tabula_create_workspace",
    {
      title: "Create Tabula Workspace",
      description:
        "Create a local Tabula workspace in this MCP session from zero or more inline Markdown files. Use tabula_create_workspace_room to turn it into a live room or tabula_share_workspace to export it.",
      inputSchema: {
        title: z.string().min(1).max(120).optional().describe("Optional workspace title."),
        files: z.array(workspaceFileInputSchema).optional().describe("Optional initial Markdown files."),
        detail: workspaceDetailSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, files, detail }) =>
      runTool(async () => {
        const workspace = compactWorkspaceResult(
          addWorkspaceResourceUris(readStoredWorkspace(await workspaces.create({ title, files: files ?? [] }))),
          detail,
        );
        server.sendResourceListChanged();
        return workspace;
      }),
  );

  server.registerTool(
    "tabula_import_markdown_workspace",
    {
      title: "Import Markdown Workspace",
      description:
        "Import Markdown into a local Tabula workspace from either this MCP server's filesystem or an inline files array. Filesystem paths are resolved where the MCP server is running.",
      inputSchema: {
        title: z.string().min(1).max(120).optional().describe("Optional workspace title."),
        detail: workspaceDetailSchema,
        source: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("local-path"),
            rootPath: z.string().min(1).describe("Directory path visible to the MCP server."),
            maxFiles: z.number().int().min(1).max(1000).default(200),
            excludeDirectories: z
              .array(z.string().min(1))
              .optional()
              .describe("Directory names to skip. Defaults include node_modules, .git, dist, build, and cache folders."),
          }),
          z.object({
            type: z.literal("files"),
            files: z.array(workspaceFileInputSchema).min(1).describe("Inline Markdown files for hosted or local MCP clients."),
          }),
        ]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, detail, source }) =>
      runTool(async () => {
        if (source.type === "local-path") {
          const importRoot = await assertLocalImportRootAllowed({
            env,
            rootPath: source.rootPath,
            server,
          });
          const workspace = compactWorkspaceResult(
            addWorkspaceResourceUris(
              readStoredWorkspace(
                await workspaces.importMarkdown({
                  title,
                  rootPath: importRoot.rootPath,
                  maxFiles: source.maxFiles,
                  excludeDirectories: source.excludeDirectories,
                }),
              ),
            ),
            detail,
          );
          server.sendResourceListChanged();
          return workspace;
        }

        const workspace = compactWorkspaceResult(
          addWorkspaceResourceUris(readStoredWorkspace(await workspaces.create({ title, files: source.files, source: "imported" }))),
          detail,
        );
        server.sendResourceListChanged();
        return workspace;
      }),
  );

  server.registerTool(
    "tabula_share_workspace",
    {
      title: "Share Tabula Workspace",
      description:
        "Export a local/imported Tabula workspace as an encrypted Tabula.md #json snapshot link. The JSON snapshot service receives only encrypted bytes.",
      inputSchema: {
        ...optionalWorkspaceSchema,
        appOrigin: z
          .string()
          .url()
          .optional()
          .describe("Tabula.md app origin for the returned share URL. Defaults to https://tabula.md."),
        jsonServerUrl: z
          .string()
          .url()
          .optional()
          .describe("Tabula JSON snapshot service URL. Defaults from appOrigin or TABULA_JSON_URL."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, appOrigin, jsonServerUrl }) =>
      runTool(async () => {
        const workspace = workspaces.get(workspaceId);
        return {
          workspaceId: workspace.workspaceId,
          share: await shareMarkdownWorkspace({
            title: workspace.title,
            files: workspaceShareFiles(workspace),
            activeFileId: workspace.workspace.activeDocumentId,
            appOrigin,
            jsonServerUrl,
          }),
        };
      }),
  );

  server.registerTool(
    "tabula_create_workspace_room",
    {
      title: "Create Tabula Workspace Room",
      description:
        "Create a new encrypted Tabula.md live workspace room from a local/imported MCP workspace, publish initial workspace state, and return a shareable #room URL.",
      inputSchema: {
        ...optionalWorkspaceSchema,
        appOrigin: z.string().url().default("https://tabula.md").describe("Tabula.md app origin for the returned #room URL."),
        roomServerUrl: z
          .string()
          .url()
          .optional()
          .describe("Tabula Room service URL. Can also be set with TABULA_ROOM_URL."),
        identityName: z.string().min(1).max(40).optional().describe("Presence name shown to collaborators."),
        identityColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Presence color as a hex value."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, appOrigin, roomServerUrl, identityName, identityColor }) =>
      runTool(async () => {
        const workspace = workspaces.get(workspaceId);
        const started = await startWorkspaceRoom({
          registry,
          workspace,
          env,
          appOrigin,
          roomServerUrl,
          identityName,
          identityColor,
          allowTemporary: allowTemporaryRooms,
        });
        server.sendResourceListChanged();
        return started;
      }),
  );

  server.registerTool(
    "tabula_connect_room",
    {
      title: "Connect Tabula Room",
      description:
        "Join this local MCP process to an encrypted Tabula.md live room URL. The #room fragment contains the room key, is used locally, and is never sent to the room server. Checkpoint recovery is optional when an active peer can send workspace state.",
      inputSchema: {
        roomUrl: z.string().url().describe("Full Tabula room invite URL, including /#room=<roomId>,<roomKey>."),
        roomServerUrl: z
          .string()
          .url()
          .optional()
          .describe("Tabula Room service URL. Can also be set with TABULA_ROOM_URL."),
        waitForStateMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(3_000)
          .describe("How long to wait for workspace state from a live peer when no encrypted checkpoint is available."),
        identityName: z.string().min(1).max(40).optional().describe("Presence name shown to collaborators."),
        identityColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Presence color as a hex value."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ roomUrl, roomServerUrl, waitForStateMs, identityName, identityColor }) =>
      runTool(async () => {
        const parsedRoom = parseRoomShareUrl(roomUrl);
        const resolvedRoomServerUrl = resolveRoomServerUrl({
          appOrigin: parsedRoom.appOrigin,
          roomServerUrl,
        });
        const client = new TabulaRoomClient({
          parsedRoom,
          roomServerUrl: resolvedRoomServerUrl,
          writeAccess: writeEnabled,
          identityName,
          identityColor,
          roomCheckpointStore: createFirebaseWorkspaceRoomCheckpointStore(env),
        });
        const recoveryStatus = await client.connect({ waitForStateMs });
        registry.add(client);
        server.sendResourceListChanged();
        const status = await client.getStatus();
        const hydrationNote = status.hydrationStatus === "ready"
          ? "Room state has been received."
          : "Connected to the live room, but no workspace state has arrived yet. Do not read or edit workspace content until tabula_wait_for_changes reports stateReceived=true.";

        return {
          ...status,
          recoveryStatus,
          note: `Connected as a Tabula agent actor. ${hydrationNote} Once ready, use tabula_read_workspace, tabula_read_workspace_document, and tabula_apply_workspace_changes for hash-guarded direct edits.`,
        };
      }),
  );

  server.registerTool(
    "tabula_list_sessions",
    {
      title: "List Tabula Room Sessions",
      description: "List Tabula room sessions currently connected in this MCP process.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool(async () => ({
        sessions: await Promise.all(registry.list().map((session) => session.getStatus())),
      })),
  );

  server.registerTool(
    "tabula_room_status",
    {
      title: "Get Tabula Room Status",
      description: "Return connection, metadata, collaborator, hash, and write-access state for a connected Tabula room.",
      inputSchema: optionalSessionSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) => runTool(async () => registry.get(sessionId).getStatus()),
  );

  server.registerTool(
    "tabula_read_workspace",
    {
      title: "Read Tabula Workspace",
      description:
        "Read decrypted Tabula workspace tree metadata from a connected room session or a local/imported MCP workspace.",
      inputSchema: {
        ...optionalWorkspaceOrSessionSchema,
        detail: workspaceDetailSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, workspaceId, detail }) =>
      runTool(async () =>
        compactWorkspaceResult(addWorkspaceResourceUris(await readWorkspaceFromSelector(registry, workspaces, { sessionId, workspaceId })), detail),
      ),
  );

  server.registerTool(
    "tabula_read_workspace_document",
    {
      title: "Read Tabula Workspace Document",
      description:
        "Read decrypted Markdown for one document from a connected room session or local/imported MCP workspace. Use tabula_read_workspace first to get document ids.",
      inputSchema: {
        ...optionalWorkspaceOrSessionSchema,
        documentId: z.string().min(1).describe("Workspace document id from tabula_read_workspace."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, workspaceId, documentId }) =>
      runTool(async () =>
        addWorkspaceDocumentResourceUri(
          await readWorkspaceDocumentFromSelector(registry, workspaces, { sessionId, workspaceId, documentId }),
        ),
      ),
  );

  server.registerTool(
    "tabula_read_workspace_context",
    {
      title: "Read Tabula Workspace Context",
      description:
        "Read a bounded Markdown context bundle from a connected room session or local/imported workspace. This is for agent planning; use tabula_read_workspace_document for exact full text.",
      inputSchema: {
        ...optionalWorkspaceOrSessionSchema,
        documentIds: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional document ids from tabula_read_workspace. Defaults to the first cached workspace documents."),
        pathGlobs: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe("Optional workspace path/title glob filters, for example docs/**/*.md or README.md."),
        query: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional case-insensitive search across document paths, titles, and cached Markdown."),
        changedSince: z
          .record(z.string().min(1), sha256HexSchema)
          .optional()
          .describe("Optional map of documentId to previous sha256; unchanged documents are skipped."),
        maxDocuments: z.number().int().min(1).max(50).default(5),
        maxCharsPerDocument: z.number().int().min(200).max(20_000).default(1_200),
        maxTotalChars: z.number().int().min(200).max(50_000).default(5_000),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, workspaceId, documentIds, pathGlobs, query, changedSince, maxDocuments, maxCharsPerDocument, maxTotalChars }) =>
      runTool(async () =>
        addWorkspaceResourceUris(
          await readWorkspaceContextFromSelector(registry, workspaces, {
            sessionId,
            workspaceId,
            documentIds,
            pathGlobs,
            query,
            changedSince,
            maxDocuments,
            maxCharsPerDocument,
            maxTotalChars,
          }),
        ),
      ),
  );

  server.registerTool(
    "tabula_apply_workspace_changes",
    {
      title: "Apply Tabula Workspace Changes",
      description:
        "Apply one or more workspace document changes atomically to the connected encrypted workspace CRDT.",
      inputSchema: {
        ...optionalSessionSchema,
        changes: z
          .array(workspaceChangeInputSchema)
          .min(1)
          .describe("Workspace changes to apply together. document.patch requires the latest baseSha256."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId, changes }) =>
      runTool(async () => registry.get(sessionId).applyWorkspaceChanges({ changes })),
  );

  server.registerTool(
    "tabula_set_presence",
    {
      title: "Set Tabula Presence",
      description: "Publish this MCP client's current cursor/selection presence to collaborators.",
      inputSchema: {
        ...optionalSessionSchema,
        fileTitle: z.string().min(1).max(120).optional(),
        selection: z
          .object({
            documentId: z.string().min(1).optional(),
            from: z.number().int().nonnegative(),
            to: z.number().int().nonnegative(),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId, selection, fileTitle }) =>
      runTool(async () => registry.get(sessionId).setPresence(selection, fileTitle)),
  );

  server.registerTool(
    "tabula_wait_for_changes",
    {
      title: "Wait for Tabula Changes",
      description:
        "Wait for a connected room's active document hash or workspace CRDT state to change, then return workspace document hash summaries.",
      inputSchema: {
        ...optionalSessionSchema,
        sinceSha256: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(0).max(30_000).default(15_000),
        includeMarkdown: z.boolean().default(false).describe("Include the active document Markdown in the result."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId, sinceSha256, timeoutMs, includeMarkdown }) =>
      runTool(async () => {
        const result = await registry.get(sessionId).waitForChange(sinceSha256, timeoutMs);
        if (includeMarkdown) {
          return {
            ...result,
            markdownIncluded: true,
          };
        }
        return {
          ...result,
          markdown: "",
          markdownIncluded: false,
          note: "Markdown omitted by default. Call tabula_read_workspace_document for exact document text, or pass includeMarkdown=true.",
        };
      }),
  );

  server.registerTool(
    "tabula_disconnect_room",
    {
      title: "Disconnect Tabula Room",
      description: "Disconnect one connected Tabula room session.",
      inputSchema: optionalSessionSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) =>
      runTool(async () => {
        const disconnectedSessionId = registry.remove(sessionId);
        server.sendResourceListChanged();
        return { disconnectedSessionId };
      }),
  );
};
