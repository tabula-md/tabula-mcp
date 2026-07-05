import { z } from "zod";
import { tabulaReadMeTopics } from "./guidance.js";

const isoDateStringSchema = z.string().datetime();
const sha256Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const possiblyClearedSha256Schema = z.union([sha256Schema, z.literal("")]);

const sessionIdOutputSchema = z.string().uuid();
const roomIdOutputSchema = z.string();
const roomHydrationStatusOutputSchema = z.enum(["waiting-for-peer-state", "ready"]);
const roomHydrationOutputShape = {
  hydrationStatus: roomHydrationStatusOutputSchema,
  stateReceived: z.boolean(),
  lastStateReceivedAt: isoDateStringSchema.optional(),
};

const liveSelectionOutputSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

const collaboratorOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  lastSeen: z.number().int().nonnegative(),
  fileTitle: z.string().optional(),
  selection: liveSelectionOutputSchema.optional(),
});

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
  textLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
  socketConnected: z.boolean(),
  ...roomHydrationOutputShape,
  peerCount: z.number().int().nonnegative(),
  collaborators: z.array(collaboratorOutputSchema),
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

export const readMarkdownOutputShape = {
  sessionId: sessionIdOutputSchema,
  roomId: roomIdOutputSchema,
  markdown: z.string(),
  textLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
  ...roomHydrationOutputShape,
};

export const outlineOutputShape = {
  sessionId: sessionIdOutputSchema,
  roomId: roomIdOutputSchema,
  outline: z.array(markdownHeadingOutputSchema),
  sha256: sha256Schema,
  ...roomHydrationOutputShape,
};

export const applyTextPatchesOutputShape = {
  sessionId: sessionIdOutputSchema,
  roomId: roomIdOutputSchema,
  changed: z.boolean(),
  textLength: z.number().int().nonnegative(),
  previousSha256: sha256Schema,
  sha256: sha256Schema,
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
