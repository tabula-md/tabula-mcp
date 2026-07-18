import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coreErrorContent } from "../core-errors.js";
import type { RuntimeEnvironment } from "../env.js";
import { exportCopy, resolveExportCopySource, type ExportCopyInput } from "../export-copy-service.js";
import { importCopy, maxImportedCopyFiles } from "../import-copy-service.js";
import type { SessionRegistry } from "../registry.js";
import { joinRoomSession, startWorkspaceSession } from "../session-service.js";
import { createWorkspaceFromFiles } from "../workspaces.js";
import {
  createSessionDirectory,
  deleteSessionPath,
  editSessionFile,
  listSessionFiles,
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
const sessionIdInputSchema = sessionIdSchema.describe("ID from Start or Join Session.");
const filePathSchema = z.string().min(1).describe("Session-relative path.");
const expectedRevisionSchema = sha256Schema.optional()
  .describe("Read revision; omit only for a new file.");
const requiredRevisionSchema = sha256Schema
  .describe("Revision returned by a Read tool.");
const markdownFileSchema = z.object({
  path: filePathSchema,
  content: z.string().describe("Complete Markdown content."),
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
    writeEnabled: boolean;
  },
) => {
  registerCoreAppTool(
    server,
    options.resourceUri,
    "tabula_start_session",
    {
      title: "Start Session",
      description: "Start an encrypted live session from Markdown files. Returns its private URL and joins the agent.",
      inputSchema: {
        title: z.string().min(1).max(120).optional()
          .describe("Optional session title."),
        files: z.array(markdownFileSchema).min(1).max(100)
          .describe("One to 100 initial Markdown files."),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
        ready: z.boolean(),
        canWrite: z.boolean(),
        fileCount: z.number().int().nonnegative(),
        otherCollaboratorCount: z.number().int().nonnegative(),
        sessionUrl: z.string().url(),
      },
      annotations: annotations(false, true),
    },
    async ({ title, files }: { title?: string; files: Array<{ path: string; content: string }> }) => run(async () => {
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
      });
      return { value: session, text: "Started a live Tabula session. The agent is connected." };
    }),
  );

  server.registerTool(
    "tabula_join_room",
    {
      title: "Join Session",
      description: "Join a private #room URL. Keep it private and continue only when ready is true.",
      inputSchema: {
        roomUrl: z.string().url()
          .describe("Private Tabula #room URL from the user."),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
        ready: z.boolean(),
        canWrite: z.boolean(),
        fileCount: z.number().int().nonnegative(),
        otherCollaboratorCount: z.number().int().nonnegative(),
      },
      annotations: annotations(false, true),
    },
    async ({ roomUrl }: { roomUrl: string }) => run(async () => {
      const session = await joinRoomSession({ registry, roomUrl, env: options.env, writeEnabled: options.writeEnabled });
      return {
        value: session,
        text: session.ready
          ? "Joined the live Tabula session. The workspace is ready."
          : "Joined the live Tabula session and is waiting for workspace state.",
      };
    }),
  );

  server.registerTool(
    "tabula_list_files",
    {
      title: "List Files",
      description: "List Markdown paths in a session. Use before reading when the target path is unknown.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: z.string().min(1).optional()
          .describe("Folder path; omit for the root."),
        recursive: z.boolean().default(true)
          .describe("Include descendants; false lists direct children."),
      },
      outputSchema: {
        files: z.array(z.union([
          z.object({ path: z.string(), type: z.literal("folder") }),
          z.object({ path: z.string(), type: z.literal("file"), revision: sha256Schema, textLength: z.number().int().nonnegative() }),
        ])),
        truncated: z.boolean(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, path, recursive }) => run(async () => ({
      value: withoutSessionId(await listSessionFiles({ registry, sessionId, path, recursive })),
      text: "Listed files in the Tabula session.",
    })),
  );

  server.registerTool(
    "tabula_read_file",
    {
      title: "Read File",
      description: "Read one Markdown file or bounded line range with its revision.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema,
        startLine: z.number().int().min(1).optional()
          .describe("First line; default 1. Not with tailLines."),
        lineCount: z.number().int().min(1).max(maxSessionReadLines).optional()
          .describe(`Line count; default 400, max ${maxSessionReadLines}. Not with tailLines.`),
        tailLines: z.number().int().min(1).max(maxSessionReadLines).optional()
          .describe(`Final line count, max ${maxSessionReadLines}. Use alone.`),
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
    "tabula_read_files",
    {
      title: "Read Files",
      description: "Read up to 20 complete Markdown files and their revisions. Read existing files before writing; batches fail rather than truncate.",
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
    "tabula_search_files",
    {
      title: "Search Files",
      description: "Search session file paths and contents; return paths, line numbers, and short excerpts.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        query: z.string().trim().min(1).max(200)
          .describe("Literal text to find in paths or content."),
        path: z.string().min(1).optional()
          .describe("Folder scope; omit for all files."),
        maxResults: z.number().int().min(1).max(100).default(20)
          .describe("Maximum matches; default 20."),
        contextLines: z.number().int().min(0).max(maxSearchContextLines).default(1)
          .describe(`Context lines before and after; default 1, max ${maxSearchContextLines}.`),
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
    "tabula_write_file",
    {
      title: "Write File",
      description: "Create or replace one Markdown file. Creates parents; replacement needs its revision.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema,
        content: z.string().describe("Complete Markdown content."),
        expectedRevision: expectedRevisionSchema,
      },
      outputSchema: {
        path: z.string(),
        created: z.boolean(),
        changed: z.boolean(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, path, content, expectedRevision }) => run(async () => ({
      value: withoutSessionId(await writeSessionFile({ registry, sessionId, path, content, expectedRevision })),
      text: `Wrote "${path}" in the Tabula session.`,
    })),
  );

  server.registerTool(
    "tabula_write_files",
    {
      title: "Write Files",
      description: "Atomically create or replace up to 100 Markdown files. Missing folders are created; include revisions for existing files.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        files: z.array(markdownFileSchema.extend({ expectedRevision: expectedRevisionSchema })).min(1).max(100)
          .describe("One to 100 complete writes in one transaction."),
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
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, files }) => run(async () => ({
      value: withoutSessionId(await writeSessionFiles({ registry, sessionId, files })),
      text: `Wrote ${files.length} Markdown file${files.length === 1 ? "" : "s"} in the Tabula session.`,
    })),
  );

  server.registerTool(
    "tabula_edit_file",
    {
      title: "Edit File",
      description: "Replace exact text in one file. Read first and pass its revision; a stale edit rebases only when oldText still matches safely.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema,
        expectedRevision: requiredRevisionSchema,
        edits: z.array(z.object({
          oldText: z.string().min(1)
            .describe("Exact text; must be unique unless replaceAll."),
          newText: z.string()
            .describe("Replacement; empty removes oldText."),
          replaceAll: z.boolean().default(false)
            .describe("Replace every occurrence; default false."),
        })).min(1).max(100)
          .describe("One to 100 replacements in order."),
      },
      outputSchema: {
        path: z.string(),
        changed: z.boolean(),
        editsApplied: z.number().int().nonnegative(),
        rebased: z.boolean(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
        diff: z.string(),
        diffTruncated: z.boolean(),
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, path, expectedRevision, edits }) => run(async () => ({
      value: withoutSessionId(await editSessionFile({ registry, sessionId, path, expectedRevision, edits })),
      text: `Applied ${edits.length} exact edit${edits.length === 1 ? "" : "s"} to "${path}".`,
    })),
  );

  server.registerTool(
    "tabula_create_directory",
    {
      title: "Create Directory",
      description: "Create a directory and any missing parents in a live session. Succeeds without changing the session when the directory already exists.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema.describe("Directory path relative to the session root."),
      },
      outputSchema: {
        path: z.string(),
        created: z.boolean(),
      },
      annotations: annotations(false, true, false, true),
    },
    async ({ sessionId, path }) => run(async () => ({
      value: withoutSessionId(await createSessionDirectory({ registry, sessionId, path })),
      text: `Created directory "${path}" in the Tabula session.`,
    })),
  );

  server.registerTool(
    "tabula_move_file",
    {
      title: "Move or Rename",
      description: "Move or rename one file or directory by changing its path. Read files first and pass expectedRevision when the source is a file; create a missing destination directory before moving into it.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        source: filePathSchema.describe("Current file or directory path relative to the session root."),
        destination: filePathSchema.describe("New full path relative to the session root."),
        expectedRevision: requiredRevisionSchema.optional()
          .describe("Read revision; required for a file and omitted for a directory."),
      },
      outputSchema: {
        source: z.string(),
        destination: z.string(),
        type: z.enum(["file", "folder"]),
        changed: z.boolean(),
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, source, destination, expectedRevision }) => run(async () => ({
      value: withoutSessionId(await moveSessionFile({ registry, sessionId, source, destination, expectedRevision })),
      text: `Moved or renamed "${source}" to "${destination}" in the Tabula session.`,
    })),
  );

  server.registerTool(
    "tabula_delete_path",
    {
      title: "Delete Path",
      description: "Delete one file or directory. Read a file first and pass its current revision; non-empty directories require recursive true.",
      inputSchema: {
        sessionId: sessionIdInputSchema,
        path: filePathSchema.describe("File or directory path relative to the session root."),
        expectedRevision: requiredRevisionSchema.optional()
          .describe("Read revision; required for a file and omitted for a directory."),
        recursive: z.boolean().default(false)
          .describe("Delete every descendant when path is a non-empty directory; defaults to false."),
      },
      outputSchema: {
        path: z.string(),
        type: z.enum(["file", "folder"]),
        deleted: z.literal(true),
      },
      annotations: annotations(false, true, true),
    },
    async ({ sessionId, path, expectedRevision, recursive }) => run(async () => ({
      value: withoutSessionId(await deleteSessionPath({ registry, sessionId, path, expectedRevision, recursive })),
      text: `Deleted "${path}" from the Tabula session.`,
    })),
  );

  server.registerTool(
    "tabula_import_copy",
    {
      title: "Import Copy",
      description: "Decrypt a private Tabula #json copy and return its relative Markdown paths and contents. Then use the host's file tools to create them in a user-chosen local folder. This does not join a live session or write to the filesystem.",
      inputSchema: {
        copyUrl: z.string().url()
          .describe("Complete private Tabula #json URL supplied by the user; keep it private."),
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
    "tabula_export_copy",
    {
      title: "Export Copy",
      description: "Create an encrypted fixed #json copy for a non-live Markdown handoff. Pass files (and optional title) for host-native Markdown, or sessionId (and optional paths) for a connected session. Pass exactly one of files or sessionId. Keep copyUrl private unless the user asks to share it.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional()
          .describe("Optional copy title; valid only with files."),
        files: z.array(markdownFileSchema).min(1).max(100).optional()
          .describe("Markdown files to export. Use files or sessionId, never both."),
        sessionId: sessionIdInputSchema.optional()
          .describe("Connected session to copy. Use sessionId or files, never both."),
        paths: z.array(filePathSchema).min(1).max(100).optional()
          .describe("Session paths to copy; omit for all files. Valid only with sessionId."),
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
    async (input: ExportCopyInput) => run(async () => {
      const source = resolveExportCopySource(input);
      const exported = await exportCopy({ source, registry, env: options.env });
      return {
        value: exported,
        text: `Created an encrypted Tabula copy containing ${exported.fileCount} Markdown file${exported.fileCount === 1 ? "" : "s"}. Keep the copy URL private.`,
      };
    }),
  );
};
