import { z } from "zod";
import { tabulaReadMeTopics } from "./guidance.js";

const isoDateStringSchema = z.string().datetime();
const sha256Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

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
  sessionId: z.string().uuid(),
  roomId: z.string(),
  status: z.string(),
  writeAccess: z.boolean(),
  textLength: z.number().int().nonnegative(),
  sha256: sha256Schema,
  peerCount: z.number().int().nonnegative(),
  collaboratorCount: z.number().int().nonnegative(),
});

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
    roomId: z.string(),
    appOrigin: z.string().url(),
    roomServerUrl: z.string().url(),
    roomUrl: z.string().url(),
    shareUrl: z.string().url(),
    textLength: z.number().int().nonnegative(),
    sha256: sha256Schema,
    encrypted: z.literal(true),
    secret: z.literal(true),
    keyLocation: z.literal("url-fragment"),
    snapshotVersion: z.number().int().positive(),
    connect: z.object({
      tool: z.literal("tabula_connect_room"),
      arguments: z.object({
        roomUrl: z.string().url(),
        roomServerUrl: z.string().url(),
      }),
    }),
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
