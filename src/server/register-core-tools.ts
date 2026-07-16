import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coreErrorContent, TabulaCoreError } from "../core-errors.js";
import type { DocumentRegistry } from "../documents/registry.js";
import { inferDocumentTitle } from "../documents/snapshot.js";
import type { DocumentStoreDeploymentMode } from "../documents/store.js";
import type { RuntimeEnvironment } from "../env.js";
import { exportCopy } from "../export-copy-service.js";
import type { SessionRegistry } from "../registry.js";
import { joinRoomSession, startDraftSession } from "../session-service.js";
import { createWorkspaceFromFiles } from "../workspaces.js";
import {
  listSessionFiles,
  readSessionFile,
  searchSessionFiles,
  writeSessionFile,
} from "../workspace-file-service.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionIdSchema = z.string().uuid();
const draftIdSchema = z.string().uuid();
const filePathSchema = z.string().min(1);

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
  documents: DocumentRegistry,
  options: {
    allowTemporaryRooms: boolean;
    deploymentMode: DocumentStoreDeploymentMode;
    env?: RuntimeEnvironment;
    resourceUri: string;
    writeEnabled: boolean;
  },
) => {
  registerCoreAppTool(
    server,
    options.resourceUri,
    "tabula_create_draft",
    {
      title: "Create Draft",
      description: "Create a private Markdown draft and show its Tabula card. Use this when the user wants a new document but has not provided a room URL.",
      inputSchema: {
        title: z.string().min(1).max(120).optional(),
        content: z.string().default(""),
      },
      outputSchema: {
        draftId: z.string().uuid(),
        title: z.string(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
      },
      annotations: annotations(false),
    },
    async ({ title, content }: { title?: string; content: string }) => run(async () => {
      const draft = await documents.create({ title, markdown: content });
      return {
        value: { draftId: draft.documentId, title: draft.title, revision: draft.sha256, textLength: draft.textLength },
        text: `Created private draft "${draft.title}".`,
      };
    }),
  );

  registerCoreAppTool(
    server,
    options.resourceUri,
    "tabula_update_draft",
    {
      title: "Update Draft",
      description: "Replace the content of a private Tabula draft and show its updated card. This tool does not edit a live session.",
      inputSchema: {
        draftId: draftIdSchema,
        title: z.string().min(1).max(120).optional(),
        content: z.string(),
        expectedRevision: sha256Schema.optional(),
      },
      outputSchema: {
        draftId: z.string().uuid(),
        title: z.string(),
        changed: z.boolean(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
      },
      annotations: annotations(false),
    },
    async ({ draftId, title, content, expectedRevision }: {
      draftId: string;
      title?: string;
      content: string;
      expectedRevision?: string;
    }) => run(async () => {
      const current = await documents.get(draftId);
      if (expectedRevision && expectedRevision !== current.sha256) {
        throw new TabulaCoreError("stale_revision", "The draft changed before the update could be applied.", {
          details: { draftId, expectedRevision, currentRevision: current.sha256 },
          retry: "Use the latest draft revision and retry.",
        });
      }
      const nextTitle = inferDocumentTitle(title ?? current.title, content);
      if (current.markdown === content && current.title === nextTitle) {
        return {
          value: { draftId, title: current.title, changed: false, revision: current.sha256, textLength: current.textLength },
          text: `Draft "${current.title}" was already up to date.`,
        };
      }
      const updated = await documents.update({ documentId: draftId, title, markdown: content });
      return {
        value: { draftId, title: updated.title, changed: true, revision: updated.sha256, textLength: updated.textLength },
        text: `Updated private draft "${updated.title}".`,
      };
    }),
  );

  registerCoreAppTool(
    server,
    options.resourceUri,
    "tabula_start_session",
    {
      title: "Start Session",
      description: "Turn a private Tabula draft into an encrypted live session, connect the agent as a collaborator, and return the private session link.",
      inputSchema: { draftId: draftIdSchema },
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
    async ({ draftId }: { draftId: string }) => run(async () => {
      const draft = await documents.get(draftId);
      const fileName = draft.title.toLocaleLowerCase().endsWith(".md") ? draft.title : `${draft.title}.md`;
      const workspace = await createWorkspaceFromFiles({
        title: draft.title,
        files: [{ path: fileName, title: fileName, markdown: draft.markdown }],
      });
      const session = await startDraftSession({
        registry,
        workspace,
        env: options.env,
        writeEnabled: options.writeEnabled,
        allowTemporaryRooms: options.allowTemporaryRooms,
      });
      return { value: session, text: "Started a live Tabula session. The agent is connected." };
    }),
  );

  registerCoreAppTool(
    server,
    options.resourceUri,
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
    "tabula_read_file",
    {
      title: "Read File",
      description: "Read the complete Markdown content of one file and return its current revision. Use the returned revision when updating the file.",
      inputSchema: { sessionId: sessionIdSchema, path: filePathSchema },
      outputSchema: {
        sessionId: z.string().uuid(),
        path: z.string(),
        content: z.string(),
        revision: sha256Schema,
        textLength: z.number().int().nonnegative(),
      },
      annotations: annotations(true, true),
    },
    async ({ sessionId, path }) => run(async () => ({
      value: await readSessionFile({ registry, sessionId, path }),
      text: `Read "${path}" from the Tabula session.`,
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
    "tabula_export_copy",
    {
      title: "Export Copy",
      description: "Export a private draft or the current state of a live session as an encrypted #json copy link. Use this for a fixed handoff; use Start Session for continued collaboration.",
      inputSchema: {
        source: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("draft"), draftId: draftIdSchema }),
          z.object({
            kind: z.literal("session"),
            sessionId: sessionIdSchema,
            paths: z.array(filePathSchema).min(1).optional(),
          }),
        ]),
      },
      outputSchema: {
        copyUrl: z.string().url(),
        fileCount: z.number().int().positive(),
        encrypted: z.literal(true),
        createdAt: z.string().datetime(),
      },
      annotations: annotations(false, true),
    },
    async ({ source }) => run(async () => {
      const exported = await exportCopy({ source, documents, registry, env: options.env });
      return {
        value: exported,
        text: `${exported.copyUrl}\nTreat this encrypted #json URL as a bearer secret.`,
      };
    }),
  );
};
