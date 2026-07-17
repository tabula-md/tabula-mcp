import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coreErrorContent } from "../core-errors.js";
import type { RuntimeEnvironment } from "../env.js";
import { exportCopy, resolveExportCopySource, type ExportCopyInput } from "../export-copy-service.js";
import type { SessionRegistry } from "../registry.js";
import { joinRoomSession, startWorkspaceSession } from "../session-service.js";
import { createWorkspaceFromFiles } from "../workspaces.js";
import {
  listSessionFiles,
  maxSessionReadFiles,
  readSessionFiles,
  searchSessionFiles,
  writeSessionFile,
  writeSessionFiles,
} from "../workspace-file-service.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionIdSchema = z.string().uuid();
const filePathSchema = z.string().min(1);
const markdownFileSchema = z.object({
  path: filePathSchema,
  content: z.string(),
});

const annotations = (readOnly: boolean, openWorld = false) => ({
  readOnlyHint: readOnly,
  destructiveHint: false,
  idempotentHint: readOnly,
  openWorldHint: openWorld,
});

const success = (value: Record<string, unknown>, text: string) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: value,
});

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
      description: "Create an encrypted live session from one or more Markdown files, connect the agent as a collaborator, and return the private session link.",
      inputSchema: {
        title: z.string().min(1).max(120).optional(),
        files: z.array(markdownFileSchema).min(1).max(100),
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
      description: "Join a live Tabula session from a private #room URL. Keep the URL private. Read and write only after ready is true.",
      inputSchema: { roomUrl: z.string().url() },
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
      description: "List Markdown files and folders in a live Tabula session. Use this first when the target file is unknown.",
      inputSchema: {
        sessionId: sessionIdSchema,
        path: z.string().min(1).optional(),
        recursive: z.boolean().default(true),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
        files: z.array(z.union([
          z.object({ path: z.string(), type: z.literal("folder") }),
          z.object({ path: z.string(), type: z.literal("file"), revision: sha256Schema, textLength: z.number().int().nonnegative() }),
        ])),
        truncated: z.boolean(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, path, recursive }) => run(async () => ({
      value: await listSessionFiles({ registry, sessionId, path, recursive }),
      text: "Listed files in the Tabula session.",
    })),
  );

  server.registerTool(
    "tabula_read_files",
    {
      title: "Read Files",
      description: "Read the complete Markdown content and current revision of up to 20 files in a live Tabula session. Preserve the returned revisions when updating existing files; large batches fail instead of returning truncated content.",
      inputSchema: {
        sessionId: sessionIdSchema,
        paths: z.array(filePathSchema).min(1).max(maxSessionReadFiles),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
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
      value: await readSessionFiles({ registry, sessionId, paths }),
      text: `Read ${paths.length} Markdown file${paths.length === 1 ? "" : "s"} from the Tabula session.`,
    })),
  );

  server.registerTool(
    "tabula_search_files",
    {
      title: "Search Files",
      description: "Search Markdown file paths and contents in a live Tabula session. Return matching paths, line numbers, and short excerpts.",
      inputSchema: {
        sessionId: sessionIdSchema,
        query: z.string().trim().min(1).max(200),
        path: z.string().min(1).optional(),
        maxResults: z.number().int().min(1).max(100).default(20),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
        matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), excerpt: z.string() })),
        truncated: z.boolean(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, query, path, maxResults }) => run(async () => ({
      value: await searchSessionFiles({ registry, sessionId, query, path, maxResults }),
      text: `Searched the Tabula session for "${query}".`,
    })),
  );

  server.registerTool(
    "tabula_write_file",
    {
      title: "Write File",
      description: "Create or replace a Markdown file in a live Tabula session. Read an existing file first and pass its revision; the server computes the collaboration patch.",
      inputSchema: {
        sessionId: sessionIdSchema,
        path: filePathSchema,
        content: z.string(),
        expectedRevision: sha256Schema.optional(),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
        path: z.string(),
        created: z.boolean(),
        changed: z.boolean(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
      },
      annotations: annotations(false, true),
    },
    async ({ sessionId, path, content, expectedRevision }) => run(async () => ({
      value: await writeSessionFile({ registry, sessionId, path, content, expectedRevision }),
      text: `Wrote "${path}" in the Tabula session.`,
    })),
  );

  server.registerTool(
    "tabula_write_files",
    {
      title: "Write Files",
      description: "Create or replace multiple Markdown files in one live Tabula session transaction. Missing folders are created. Read existing files first and include each revision.",
      inputSchema: {
        sessionId: sessionIdSchema,
        files: z.array(markdownFileSchema.extend({ expectedRevision: sha256Schema.optional() })).min(1).max(100),
      },
      outputSchema: {
        sessionId: z.string().uuid(),
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
      annotations: annotations(false, true),
    },
    async ({ sessionId, files }) => run(async () => ({
      value: await writeSessionFiles({ registry, sessionId, files }),
      text: `Wrote ${files.length} Markdown file${files.length === 1 ? "" : "s"} in the Tabula session.`,
    })),
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
        sessionId: sessionIdSchema.optional()
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
