import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WORKSPACE_ROOM_MAX_COMMENT_LENGTH } from "@tabula-md/tabula/collaboration";
import { coreErrorContent } from "../core-errors.js";
import type { TabulaAgentIdentity } from "../agent-identity.js";
import {
  addSessionComment,
  defaultCommentPageSize,
  deleteSessionComment,
  listSessionComments,
  maxCommentPageSize,
  replyToSessionComment,
  setSessionCommentResolved,
} from "../comments-service.js";
import type { RuntimeEnvironment } from "../env.js";
import { exportCopy, resolveExportCopySource, type ExportCopyInput } from "../export-copy-service.js";
import { importCopy, maxImportedCopyFiles } from "../import-copy-service.js";
import type { SessionRegistry } from "../registry.js";
import { joinRoomSession, startWorkspaceSession } from "../session-service.js";
import { createWorkspaceFromFiles } from "../workspaces.js";
import { OperationLedger } from "./operation-ledger.js";
import { getCoreToolMetadata } from "./tool-metadata.js";
import {
  createSessionDirectory,
  deleteSessionPath,
  editSessionFile,
  listSessionFiles,
  defaultSessionListEntries,
  maxSessionListEntries,
  maxSearchContextLines,
  maxSessionReadFiles,
  maxSessionReadLines,
  moveSessionFile,
  readSessionFile,
  readSessionFiles,
  searchSessionFiles,
  writeSessionFile,
  writeSessionFiles,
} from "../workspace-file-service.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionIdSchema = z.string().min(1).max(100);
const sessionIdInputSchema = sessionIdSchema
  .describe("Session ID returned by Start Session or Join Room; never guess or reuse one from another session.");
const filePathSchema = z.string().min(1)
  .describe("Relative path inside the connected Tabula.md session; not a local filesystem path.");
const handoffFilePathSchema = z.string().min(1)
  .describe("Relative Markdown path in the Tabula.md workspace; never pass an absolute local filesystem path.");
const expectedRevisionSchema = sha256Schema.optional()
  .describe("Current revision from Read File, Read Multiple Files, or a previous mutation; omit only for a new file.");
const requiredRevisionSchema = sha256Schema
  .describe("Current revision from Read File, Read Multiple Files, or a previous mutation in this session.");
const markdownFileSchema = z.object({
  path: handoffFilePathSchema,
  content: z.string().describe("Complete Markdown."),
});
const commentReplyOutputSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  author: z.string(),
  createdAt: z.string().datetime(),
});
const commentOutputSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  body: z.string(),
  author: z.string(),
  createdAt: z.string().datetime(),
  resolved: z.boolean(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  quote: z.string().optional(),
  replies: z.array(commentReplyOutputSchema),
});
const mutationStateOutputSchema = {
  applied: z.literal(true),
  persisted: z.boolean(),
  checkpointPending: z.boolean(),
};
const sessionFileOutputSchema = z.object({
  path: z.string(),
  revision: sha256Schema,
  textLength: z.number().int().nonnegative(),
});

const annotations = (readOnly: boolean, openWorld = false, destructive = false, idempotent = readOnly) => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: openWorld,
});

const success = (value: Record<string, unknown>, text: string) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: value,
});

const withoutSessionId = <T extends { sessionId: string }>({ sessionId: _sessionId, ...value }: T) => value;
const mutationText = (text: string, value: { checkpointPending: boolean }) => value.checkpointPending
  ? `${text} The live change succeeded; its recovery checkpoint is retrying.`
  : text;

const run = async (handler: () => Promise<{ value: Record<string, unknown>; text: string }>) => {
  try {
    const result = await handler();
    return success(result.value, result.text);
  } catch (error) {
    return coreErrorContent(error);
  }
};

const registerCoreAppTool = (
  server: McpServer,
  resourceUri: string,
  name: string,
  config: any,
  handler: any,
) => registerAppTool(server, name, {
  ...config,
  _meta: { ui: { resourceUri } },
}, handler);

export const registerCoreTools = (
  server: McpServer,
  registry: SessionRegistry,
  options: {
    allowTemporaryRooms: boolean;
    env?: RuntimeEnvironment;
    resourceUri: string;
    resolveAgentIdentity: () => TabulaAgentIdentity;
    writeEnabled: boolean;
  },
) => {
  const operationLedger = new OperationLedger();
  const runMutation = (
    toolName: string,
    input: unknown,
    handler: () => Promise<{ value: Record<string, unknown>; text: string }>,
  ) => run(() => operationLedger.run(toolName, input, handler));
  const runInFlightMutation = (
    toolName: string,
    input: unknown,
    handler: () => Promise<{ value: Record<string, unknown>; text: string }>,
  ) => run(() => operationLedger.runInFlight(toolName, input, handler));

  registerCoreAppTool(
    server,
    options.resourceUri,
    "start_session",
    {
      ...getCoreToolMetadata("start_session"),
      inputSchema: {
        title: z.string().min(1).max(120).optional()
          .describe("Session title."),
        files: z.array(markdownFileSchema).min(1).max(100)
          .describe("One to 100 initial files."),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
        idleTimeoutSeconds: z.number().int().positive(),
        ready: z.boolean(),
        canWrite: z.boolean(),
        fileCount: z.number().int().nonnegative(),
        files: z.array(sessionFileOutputSchema),
        presenceReady: z.boolean(),
        otherCollaboratorCount: z.number().int().nonnegative().optional(),
        sessionUrl: z.string().url(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true),
    },
    async ({ title, files }: { title?: string; files: Array<{ path: string; content: string }> }) => runMutation(
      "start_session",
      { title, files },
      async () => {
      const workspace = await createWorkspaceFromFiles({
        title,
        files: files.map((file) => ({ path: file.path, markdown: file.content })),
      });
      const session = await startWorkspaceSession({
        registry,
        workspace,
        env: options.env,
        writeEnabled: options.writeEnabled,
        allowTemporaryRooms: options.allowTemporaryRooms,
        identity: options.resolveAgentIdentity(),
      });
      return { value: session, text: "Started a live Tabula session. The agent is connected." };
      },
    ),
  );

  server.registerTool(
    "join_room",
    {
      ...getCoreToolMetadata("join_room"),
      inputSchema: {
        roomUrl: z.string().url()
          .describe("Private #room URL from the user."),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
        idleTimeoutSeconds: z.number().int().positive(),
        ready: z.boolean(),
        canWrite: z.boolean(),
        fileCount: z.number().int().nonnegative(),
        presenceReady: z.boolean(),
        otherCollaboratorCount: z.number().int().nonnegative().optional(),
        reused: z.boolean(),
      },
      annotations: annotations(false, true, false, true),
    },
    async ({ roomUrl }: { roomUrl: string }) => runInFlightMutation("join_room", { roomUrl }, async () => {
      const session = await joinRoomSession({
        registry,
        roomUrl,
        env: options.env,
        writeEnabled: options.writeEnabled,
        identity: options.resolveAgentIdentity(),
      });
      return {
        value: session,
        text: session.ready
          ? "Joined the live Tabula session. The workspace is ready."
          : "Joined the live Tabula session and is waiting for workspace state.",
      };
    }),
  );

  server.registerTool(
    "leave_session",
    {
      ...getCoreToolMetadata("leave_session"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
      },
      outputSchema: {
        sessionId: sessionIdSchema,
        left: z.boolean(),
        reason: z.literal("already_left").optional(),
      },
      annotations: annotations(false, true, false, true),
    },
    async ({ sessionId }: { sessionId: string }) => run(async () => {
      const left = await registry.leave(sessionId);
      return {
        value: {
          sessionId,
          left,
          ...(!left ? { reason: "already_left" as const } : {}),
        },
        text: left
          ? "Left the Tabula live session. The room and its files were not deleted."
          : "The Tabula live session was already disconnected.",
      };
    }),
  );

  server.registerTool(
    "list_files",
    {
      ...getCoreToolMetadata("list_files"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: z.string().min(1).optional()
          .describe("Folder path; omit for the root."),
        recursive: z.boolean().default(true)
          .describe("Include descendants; false lists children."),
        limit: z.number().int().min(1).max(maxSessionListEntries).default(defaultSessionListEntries)
          .describe(`Paths per page; default ${defaultSessionListEntries}, max ${maxSessionListEntries}.`),
        cursor: z.string().min(1).max(4_096).optional()
          .describe("Opaque nextCursor from the previous page; omit for the first page."),
      },
      outputSchema: {
        files: z.array(z.union([
          z.object({ path: z.string(), type: z.literal("folder") }),
          z.object({ path: z.string(), type: z.literal("file"), revision: sha256Schema, textLength: z.number().int().nonnegative() }),
        ])),
        truncated: z.boolean(),
        nextCursor: z.string().optional(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, path, recursive, limit, cursor }) => run(async () => ({
      value: withoutSessionId(await listSessionFiles({ registry, sessionId, path, recursive, limit, cursor })),
      text: "Listed files in the Tabula session.",
    })),
  );

  server.registerTool(
    "read_file",
    {
      ...getCoreToolMetadata("read_file"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema,
        startLine: z.number().int().min(1).optional()
          .describe("First line; not with tailLines."),
        lineCount: z.number().int().min(1).max(maxSessionReadLines).optional()
          .describe(`Line count; max ${maxSessionReadLines}. Not with tailLines.`),
        tailLines: z.number().int().min(1).max(maxSessionReadLines).optional()
          .describe(`Final lines; max ${maxSessionReadLines}. Use alone.`),
      },
      outputSchema: {
        path: z.string(),
        content: z.string(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
        totalLines: z.number().int().positive(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        truncated: z.boolean(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, path, startLine, lineCount, tailLines }) => run(async () => ({
      value: withoutSessionId(await readSessionFile({ registry, sessionId, path, startLine, lineCount, tailLines })),
      text: `Read Markdown from "${path}" in the Tabula session.`,
    })),
  );

  server.registerTool(
    "read_multiple_files",
    {
      ...getCoreToolMetadata("read_multiple_files"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        paths: z.array(filePathSchema).min(1).max(maxSessionReadFiles)
          .describe("One to 20 paths, returned in order."),
      },
      outputSchema: {
        files: z.array(z.object({
          path: z.string(),
          content: z.string(),
          revision: sha256Schema,
          textLength: z.number().int().nonnegative(),
        })).max(maxSessionReadFiles),
        totalCharacters: z.number().int().nonnegative(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, paths }) => run(async () => ({
      value: withoutSessionId(await readSessionFiles({ registry, sessionId, paths })),
      text: `Read ${paths.length} Markdown file${paths.length === 1 ? "" : "s"} from the Tabula session.`,
    })),
  );

  server.registerTool(
    "search_files",
    {
      ...getCoreToolMetadata("search_files"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        query: z.string().trim().min(1).max(200)
          .describe("Literal text in paths or content."),
        path: z.string().min(1).optional()
          .describe("File or folder scope; omit for all."),
        maxResults: z.number().int().min(1).max(100).default(20)
          .describe("Maximum matches; default 20."),
        contextLines: z.number().int().min(0).max(maxSearchContextLines).default(1)
          .describe(`Nearby lines; default 1, max ${maxSearchContextLines}.`),
      },
      outputSchema: {
        matches: z.array(z.object({
          path: z.string(),
          kind: z.enum(["path", "content"]),
          line: z.number().int().positive(),
          match: z.string(),
          before: z.array(z.string()),
          after: z.array(z.string()),
        })),
        truncated: z.boolean(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, query, path, maxResults, contextLines }) => run(async () => ({
      value: withoutSessionId(await searchSessionFiles({ registry, sessionId, query, path, maxResults, contextLines })),
      text: `Searched the Tabula session for "${query}".`,
    })),
  );

  server.registerTool(
    "list_comments",
    {
      ...getCoreToolMetadata("list_comments"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema.optional()
          .describe("File path; omit for comments across the session."),
        status: z.enum(["open", "resolved", "all"]).default("open")
          .describe("Comment status; default open."),
        limit: z.number().int().min(1).max(maxCommentPageSize).default(defaultCommentPageSize)
          .describe(`Comments per page; default ${defaultCommentPageSize}, max ${maxCommentPageSize}.`),
        cursor: z.string().min(1).max(4_096).optional()
          .describe("Opaque nextCursor from the previous page."),
      },
      outputSchema: {
        comments: z.array(commentOutputSchema),
        truncated: z.boolean(),
        nextCursor: z.string().optional(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, path, status, limit, cursor }) => run(async () => ({
      value: withoutSessionId(await listSessionComments({ registry, sessionId, path, status, limit, cursor })),
      text: "Listed comments in the Tabula session.",
    })),
  );

  server.registerTool(
    "add_comment",
    {
      ...getCoreToolMetadata("add_comment"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema,
        body: z.string().trim().min(1).max(WORKSPACE_ROOM_MAX_COMMENT_LENGTH)
          .describe("Comment text."),
        startLine: z.number().int().min(1).optional()
          .describe("First anchored line; provide with endLine."),
        endLine: z.number().int().min(1).optional()
          .describe("Last anchored line, inclusive; provide with startLine."),
      },
      outputSchema: {
        commentId: z.string().uuid(),
        path: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true),
    },
    async ({ sessionId, path, body, startLine, endLine }) => runMutation(
      "add_comment",
      { sessionId, path, body, startLine, endLine },
      async () => {
        const value = withoutSessionId(await addSessionComment({
          registry,
          sessionId,
          path,
          body,
          startLine,
          endLine,
        }));
        return { value, text: mutationText(`Added a comment to "${path}".`, value) };
      },
    ),
  );

  server.registerTool(
    "reply_to_comment",
    {
      ...getCoreToolMetadata("reply_to_comment"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        commentId: z.string().uuid().describe("Comment ID from List Comments."),
        body: z.string().trim().min(1).max(WORKSPACE_ROOM_MAX_COMMENT_LENGTH)
          .describe("Reply text."),
      },
      outputSchema: {
        commentId: z.string().uuid(),
        path: z.string(),
        replyId: z.string().uuid(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true),
    },
    async ({ sessionId, commentId, body }) => runMutation(
      "reply_to_comment",
      { sessionId, commentId, body },
      async () => {
        const value = withoutSessionId(await replyToSessionComment({ registry, sessionId, commentId, body }));
        return { value, text: mutationText("Replied to the Tabula comment.", value) };
      },
    ),
  );

  server.registerTool(
    "resolve_comment",
    {
      ...getCoreToolMetadata("resolve_comment"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        commentId: z.string().uuid().describe("Comment ID from List Comments."),
        resolved: z.boolean().describe("True resolves; false reopens."),
      },
      outputSchema: {
        commentId: z.string().uuid(),
        path: z.string(),
        resolved: z.boolean(),
        changed: z.boolean(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true, false, true),
    },
    async ({ sessionId, commentId, resolved }) => runMutation(
      "resolve_comment",
      { sessionId, commentId, resolved },
      async () => {
        const value = withoutSessionId(await setSessionCommentResolved({
          registry,
          sessionId,
          commentId,
          resolved,
        }));
        return {
          value,
          text: mutationText(resolved ? "Resolved the Tabula comment." : "Reopened the Tabula comment.", value),
        };
      },
    ),
  );

  server.registerTool(
    "delete_comment",
    {
      ...getCoreToolMetadata("delete_comment"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        commentId: z.string().uuid().describe("Comment ID from List Comments."),
      },
      outputSchema: {
        commentId: z.string().uuid(),
        path: z.string(),
        deleted: z.literal(true),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, commentId }) => runMutation(
      "delete_comment",
      { sessionId, commentId },
      async () => {
        const value = withoutSessionId(await deleteSessionComment({ registry, sessionId, commentId }));
        return { value, text: mutationText("Deleted the Tabula comment.", value) };
      },
    ),
  );

  server.registerTool(
    "write_file",
    {
      ...getCoreToolMetadata("write_file"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema,
        content: z.string().describe("Complete Markdown."),
        expectedRevision: expectedRevisionSchema,
      },
      outputSchema: {
        path: z.string(),
        created: z.boolean(),
        changed: z.boolean(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, path, content, expectedRevision }) => runMutation(
      "write_file",
      { sessionId, path, content, expectedRevision },
      async () => {
      const value = withoutSessionId(await writeSessionFile({ registry, sessionId, path, content, expectedRevision }));
      return { value, text: mutationText(`Wrote "${path}" in the Tabula session.`, value) };
      },
    ),
  );

  server.registerTool(
    "write_files",
    {
      ...getCoreToolMetadata("write_files"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        files: z.array(markdownFileSchema.extend({ expectedRevision: expectedRevisionSchema })).min(1).max(100)
          .describe("One to 100 complete file writes."),
      },
      outputSchema: {
        files: z.array(z.object({
          path: z.string(),
          created: z.boolean(),
          changed: z.boolean(),
          revision: sha256Schema,
          textLength: z.number().int().nonnegative(),
        })),
        createdCount: z.number().int().nonnegative(),
        changedCount: z.number().int().nonnegative(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, files }) => runMutation("write_files", { sessionId, files }, async () => {
      const value = withoutSessionId(await writeSessionFiles({ registry, sessionId, files }));
      return {
        value,
        text: mutationText(
          `Wrote ${files.length} Markdown file${files.length === 1 ? "" : "s"} in the Tabula session.`,
          value,
        ),
      };
    }),
  );

  server.registerTool(
    "edit_file",
    {
      ...getCoreToolMetadata("edit_file"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema,
        expectedRevision: requiredRevisionSchema,
        edits: z.array(z.object({
          oldText: z.string().min(1)
            .describe("Exact text; unique unless replaceAll."),
          newText: z.string()
            .describe("Replacement; empty removes it."),
          replaceAll: z.boolean().default(false)
            .describe("Replace every occurrence; default false."),
        })).min(1).max(100)
          .describe("One to 100 ordered replacements."),
      },
      outputSchema: {
        path: z.string(),
        changed: z.boolean(),
        editsApplied: z.number().int().nonnegative(),
        rebased: z.boolean(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
        ...mutationStateOutputSchema,
        diff: z.string(),
        diffTruncated: z.boolean(),
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, path, expectedRevision, edits }) => runMutation(
      "edit_file",
      { sessionId, path, expectedRevision, edits },
      async () => {
      const value = withoutSessionId(await editSessionFile({ registry, sessionId, path, expectedRevision, edits }));
      return {
        value,
        text: mutationText(
          `Applied ${edits.length} exact edit${edits.length === 1 ? "" : "s"} to "${path}".`,
          value,
        ),
      };
      },
    ),
  );

  server.registerTool(
    "create_directory",
    {
      ...getCoreToolMetadata("create_directory"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema.describe("Relative directory path."),
      },
      outputSchema: {
        path: z.string(),
        created: z.boolean(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true, false, true),
    },
    async ({ sessionId, path }) => runMutation("create_directory", { sessionId, path }, async () => {
      const value = withoutSessionId(await createSessionDirectory({ registry, sessionId, path }));
      return { value, text: mutationText(`Created directory "${path}" in the Tabula session.`, value) };
    }),
  );

  server.registerTool(
    "move_file",
    {
      ...getCoreToolMetadata("move_file"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        source: filePathSchema.describe("Current relative path."),
        destination: filePathSchema.describe("New relative path whose parent directory already exists."),
        expectedRevision: requiredRevisionSchema.optional()
          .describe("Required for a file; omit for a directory."),
      },
      outputSchema: {
        source: z.string(),
        destination: z.string(),
        type: z.enum(["file", "folder"]),
        changed: z.boolean(),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, source, destination, expectedRevision }) => runMutation(
      "move_file",
      { sessionId, source, destination, expectedRevision },
      async () => {
      const value = withoutSessionId(await moveSessionFile({ registry, sessionId, source, destination, expectedRevision }));
      return {
        value,
        text: mutationText(`Moved or renamed "${source}" to "${destination}" in the Tabula session.`, value),
      };
      },
    ),
  );

  server.registerTool(
    "delete_path",
    {
      ...getCoreToolMetadata("delete_path"),
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema.describe("Relative file or directory path."),
        expectedRevision: requiredRevisionSchema.optional()
          .describe("Required for a file; omit for a directory."),
        recursive: z.boolean().default(false)
          .describe("Delete descendants; default false."),
      },
      outputSchema: {
        path: z.string(),
        type: z.enum(["file", "folder"]),
        deleted: z.literal(true),
        ...mutationStateOutputSchema,
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, path, expectedRevision, recursive }) => runMutation(
      "delete_path",
      { sessionId, path, expectedRevision, recursive },
      async () => {
      const value = withoutSessionId(await deleteSessionPath({ registry, sessionId, path, expectedRevision, recursive }));
      return { value, text: mutationText(`Deleted "${path}" from the Tabula session.`, value) };
      },
    ),
  );

  server.registerTool(
    "import_copy",
    {
      ...getCoreToolMetadata("import_copy"),
      inputSchema: {
        copyUrl: z.string().url()
          .describe("Private #json URL from the user."),
      },
      outputSchema: {
        title: z.string(),
        files: z.array(markdownFileSchema).min(1).max(maxImportedCopyFiles),
        fileCount: z.number().int().positive(),
        totalCharacters: z.number().int().nonnegative(),
        activePath: z.string().optional(),
        createdAt: z.string().datetime(),
        commentCount: z.number().int().nonnegative(),
      },
      annotations: annotations(true, true),
    },
    async ({ copyUrl }: { copyUrl: string }) => run(async () => {
      const imported = await importCopy({ copyUrl, env: options.env });
      return {
        value: imported,
        text: `Imported ${imported.fileCount} Markdown file${imported.fileCount === 1 ? "" : "s"} from the encrypted Tabula copy. Preserve the returned relative paths when writing them locally, and do not overwrite existing files without the user's approval.`,
      };
    }),
  );

  registerCoreAppTool(
    server,
    options.resourceUri,
    "export_copy",
    {
      ...getCoreToolMetadata("export_copy"),
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional()
          .describe("Copy title; files source only."),
        files: z.array(markdownFileSchema).min(1).max(100).optional()
          .describe("Files source; files or sessionId, never both."),
        sessionId: sessionIdInputSchema.optional()
          .describe("Session source; files or sessionId, never both."),
        paths: z.array(filePathSchema).min(1).max(100).optional()
          .describe("Session paths; omit for all. sessionId only."),
      }).meta({
        examples: [
          { files: [{ path: "sample.md", content: "# Sample\n" }] },
          { sessionId: "00000000-0000-4000-8000-000000000000", paths: ["sample.md"] },
        ],
      }),
      outputSchema: {
        copyUrl: z.string().url(),
        fileCount: z.number().int().positive(),
        encrypted: z.literal(true),
        createdAt: z.string().datetime(),
        expiresAt: z.string().datetime().optional(),
      },
      annotations: annotations(false, true),
    },
    async (input: ExportCopyInput) => runMutation("export_copy", input, async () => {
      const source = resolveExportCopySource(input);
      const exported = await exportCopy({ source, registry, env: options.env });
      return {
        value: exported,
        text: `Created an encrypted Tabula copy containing ${exported.fileCount} Markdown file${exported.fileCount === 1 ? "" : "s"}. Keep the copy URL private.`,
      };
    }),
  );
};
