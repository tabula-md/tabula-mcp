import { z } from "zod";
import { tabulaReadMeTopics } from "./guidance.js";

const isoDateStringSchema = z.string().datetime();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const possiblyClearedSha256Schema = z.union([sha256Schema, z.literal("")]);

const sessionIdOutputSchema = z.string().uuid();
const workspaceIdOutputSchema = z.string().uuid();
const roomIdOutputSchema = z.string();
const roomHydrationStatusOutputSchema = z.enum(["waiting-for-peer-state", "ready"]);
const roomHydrationOutputShape = {
  hydrationStatus: roomHydrationStatusOutputSchema,
  stateReceived: z.boolean(),
  lastStateReceivedAt: isoDateStringSchema.optional(),
};

const liveSelectionOutputSchema = z.object({
  documentId: z.string().optional(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

const roomCapabilityOutputSchema = z.enum(["presence", "read", "propose", "comment", "write", "create", "delete", "move"]);

const roomActorOutputSchema = z.object({
  id: z.string(),
  kind: z.enum(["human", "agent"]),
  name: z.string(),
  client: z.enum(["tabula-md", "tabula-mcp", "custom"]),
  capabilities: z.array(roomCapabilityOutputSchema),
  color: z.string().optional(),
  joinedAt: isoDateStringSchema,
});

const collaboratorOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  lastSeen: z.number().int().nonnegative(),
  fileTitle: z.string().optional(),
  selection: liveSelectionOutputSchema.optional(),
  actor: roomActorOutputSchema.optional(),
});

const textPatchOutputSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  insert: z.string(),
});

const workspaceFolderNodeOutputSchema = z.object({
  id: z.string(),
  type: z.literal("folder"),
  parentId: z.string().nullable(),
  title: z.string(),
  order: z.number().optional(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});

const workspaceDocumentNodeOutputSchema = z.object({
  id: z.string(),
  type: z.literal("document"),
  parentId: z.string().nullable(),
  title: z.string(),
  sha256: sha256Schema,
  textLength: z.number().int().nonnegative(),
  order: z.number().optional(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});

const workspaceNodeOutputSchema = z.union([workspaceFolderNodeOutputSchema, workspaceDocumentNodeOutputSchema]);

const workspaceDocumentSummaryOutputSchema = workspaceDocumentNodeOutputSchema.extend({
  cached: z.boolean(),
  path: z.string().optional(),
});

const workspaceRoomStateOutputSchema = z.object({
  roomId: roomIdOutputSchema,
  mode: z.literal("workspace"),
  version: z.number(),
  rootId: z.string(),
  nodes: z.array(workspaceNodeOutputSchema),
  activeDocumentId: z.string().optional(),
});

const workspaceChangeOutputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("document.patch"),
    documentId: z.string(),
    baseSha256: sha256Schema,
    patches: z.array(textPatchOutputSchema),
  }),
  z.object({
    type: z.literal("document.create"),
    parentId: z.string().nullable(),
    title: z.string(),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal("document.rename"),
    documentId: z.string(),
    title: z.string(),
  }),
  z.object({
    type: z.literal("document.move"),
    documentId: z.string(),
    parentId: z.string().nullable(),
  }),
  z.object({
    type: z.literal("document.delete"),
    documentId: z.string(),
    baseSha256: sha256Schema.optional(),
  }),
]);

const workspaceProposalOutputSchema = z.object({
  id: z.string(),
  roomId: roomIdOutputSchema,
  actorId: z.string(),
  actor: roomActorOutputSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  createdAt: isoDateStringSchema,
  status: z.literal("pending"),
  changes: z.array(workspaceChangeOutputSchema),
});

const roomEventOutputSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    roomId: roomIdOutputSchema,
    actorId: z.string(),
    actor: roomActorOutputSchema.optional(),
    createdAt: isoDateStringSchema,
  })
  .passthrough();

export const markdownHeadingOutputSchema = z.object({
  depth: z.number().int().min(1).max(6),
  text: z.string(),
  line: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const documentSummaryOutputSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string(),
  source: z.literal("local-document"),
  status: z.literal("draft"),
  textLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
  outlineCount: z.number().int().nonnegative(),
});

export const documentSnapshotOutputShape = {
  mode: z.literal("document"),
  document: documentSummaryOutputSchema,
  markdown: z.string(),
  outline: z.array(markdownHeadingOutputSchema),
  resourceUri: z.string().optional(),
};

export const documentListOutputShape = {
  documents: z.array(documentSummaryOutputSchema),
};

export const roomSummaryOutputSchema = z.object({
  sessionId: sessionIdOutputSchema,
  roomId: roomIdOutputSchema,
  shareUrl: z.string().url().optional(),
  status: z.string(),
  writeAccess: z.boolean(),
  textLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
  peerCount: z.number().int().nonnegative(),
  collaboratorCount: z.number().int().nonnegative(),
  ...roomHydrationOutputShape,
});

export const roomStatusOutputShape = {
  sessionId: sessionIdOutputSchema,
  roomId: roomIdOutputSchema,
  shareUrl: z.string().url().optional(),
  roomServerUrl: z.string().url(),
  status: z.enum(["connecting", "connected", "offline", "closed"]),
  writeAccess: z.boolean(),
  actor: roomActorOutputSchema,
  capabilities: z.array(roomCapabilityOutputSchema),
  textLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
  socketConnected: z.boolean(),
  ...roomHydrationOutputShape,
  peerCount: z.number().int().nonnegative(),
  collaborators: z.array(collaboratorOutputSchema),
  pendingProposalCount: z.number().int().nonnegative(),
  pendingWorkspaceProposalCount: z.number().int().nonnegative().optional(),
  workspaceMode: z.boolean().optional(),
  activeDocumentId: z.string().optional(),
  workspaceVersion: z.number().optional(),
  lastRoomEventAt: isoDateStringSchema.optional(),
  metadata: z.unknown().nullable(),
  lastError: z.string().optional(),
};

export const connectRoomOutputShape = {
  ...roomStatusOutputShape,
  recoveryStatus: z.literal("relay-only"),
  note: z.string(),
};

export const listSessionsOutputShape = {
  sessions: z.array(z.object(roomStatusOutputShape)),
};

export const readWorkspaceOutputShape = {
  sessionId: sessionIdOutputSchema.optional(),
  workspaceId: workspaceIdOutputSchema.optional(),
  roomId: roomIdOutputSchema,
  workspace: workspaceRoomStateOutputSchema.nullable(),
  activeDocumentId: z.string().optional(),
  documents: z.array(workspaceDocumentSummaryOutputSchema),
  cachedDocumentCount: z.number().int().nonnegative(),
  pendingWorkspaceProposalCount: z.number().int().nonnegative(),
  ...roomHydrationOutputShape,
  createdAt: isoDateStringSchema.optional(),
  updatedAt: isoDateStringSchema.optional(),
  source: z.enum(["created", "imported"]).optional(),
  sourceRootPath: z.string().optional(),
  note: z.string().optional(),
};

export const readWorkspaceDocumentOutputShape = {
  sessionId: sessionIdOutputSchema.optional(),
  workspaceId: workspaceIdOutputSchema.optional(),
  roomId: roomIdOutputSchema,
  documentId: z.string(),
  path: z.string().optional(),
  title: z.string(),
  markdown: z.string(),
  textLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
  cachedAt: isoDateStringSchema,
  ...roomHydrationOutputShape,
};

export const createWorkspaceOutputShape = readWorkspaceOutputShape;

export const createWorkspaceRoomOutputShape = {
  ...connectRoomOutputShape,
  workspaceId: workspaceIdOutputSchema,
  roomUrl: z.string().url(),
  published: z.object({
    emittedWorkspace: z.boolean(),
    emittedDocumentCount: z.number().int().nonnegative(),
  }),
};

export const proposeWorkspaceChangesOutputShape = {
  sessionId: sessionIdOutputSchema,
  roomId: roomIdOutputSchema,
  emitted: z.boolean(),
  proposal: workspaceProposalOutputSchema,
  note: z.string().optional(),
};

export const setPresenceOutputShape = {
  sessionId: sessionIdOutputSchema,
  roomId: roomIdOutputSchema,
  identity: collaboratorOutputSchema,
};

export const waitForChangesOutputShape = {
  changed: z.boolean(),
  markdown: z.string(),
  sha256: possiblyClearedSha256Schema,
  ...roomHydrationOutputShape,
  roomEvents: z.array(roomEventOutputSchema).optional(),
};

export const disconnectRoomOutputShape = {
  disconnectedSessionId: sessionIdOutputSchema,
};

export const roomViewOutputShape = {
  mode: z.literal("room"),
  room: roomSummaryOutputSchema,
  resourceUri: z.string().optional(),
};

export const roomSnapshotOutputShape = {
  mode: z.literal("room"),
  room: roomSummaryOutputSchema,
  status: roomSummaryOutputSchema,
  markdown: z.string(),
  outline: z.array(markdownHeadingOutputSchema),
};

export const shareOutputShape = {
  share: z.object({
    title: z.string(),
    linkKind: z.literal("json-snapshot"),
    snapshotId: z.string(),
    appOrigin: z.string().url(),
    jsonServerUrl: z.string().url(),
    snapshotUrl: z.string().url(),
    shareUrl: z.string().url(),
    textLength: z.number().int().nonnegative(),
    sha256: sha256Schema,
    encrypted: z.literal(true),
    secret: z.literal(true),
    keyLocation: z.literal("url-fragment"),
    expiresAt: isoDateStringSchema.optional(),
  }),
};

export const shareWorkspaceOutputShape = {
  workspaceId: workspaceIdOutputSchema,
  share: z.object({
    title: z.string(),
    linkKind: z.literal("json-snapshot"),
    snapshotId: z.string(),
    appOrigin: z.string().url(),
    jsonServerUrl: z.string().url(),
    snapshotUrl: z.string().url(),
    shareUrl: z.string().url(),
    fileCount: z.number().int().nonnegative(),
    textLength: z.number().int().nonnegative(),
    sha256: sha256Schema,
    encrypted: z.literal(true),
    secret: z.literal(true),
    keyLocation: z.literal("url-fragment"),
    expiresAt: isoDateStringSchema.optional(),
  }),
};

export const readMeOutputShape = {
  readMe: z.object({
    product: z.literal("Tabula.md"),
    topic: z.enum(tabulaReadMeTopics),
    summary: z.string(),
    nextActions: z.array(z.string()),
    securityRules: z.array(z.string()),
    avoid: z.array(z.string()),
  }),
};
