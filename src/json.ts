const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

type JsonContentOptions = {
  compactThresholdBytes?: number;
  summary?: string;
};

const defaultCompactThresholdBytes = 2_048;
const maxResourceLinks = 12;

const stringValue = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const summarizeObject = (value: Record<string, unknown>) => {
  const parts = ["Tabula MCP returned structuredContent."];
  const workspaceId = stringValue(value.workspaceId);
  const sessionId = stringValue(value.sessionId);
  const roomId = stringValue(value.roomId);
  const documentId = stringValue(value.documentId);
  const resourceUri = stringValue(value.resourceUri);
  const documents = Array.isArray(value.documents) ? value.documents : undefined;
  const sessions = Array.isArray(value.sessions) ? value.sessions : undefined;
  const roomEvents = Array.isArray(value.roomEvents) ? value.roomEvents : undefined;

  if (workspaceId) {
    parts.push(`workspaceId=${workspaceId}`);
  }
  if (sessionId) {
    parts.push(`sessionId=${sessionId}`);
  }
  if (roomId) {
    parts.push(`roomId=${roomId}`);
  }
  if (documentId) {
    parts.push(`documentId=${documentId}`);
  }
  if (documents) {
    parts.push(`documents=${documents.length}`);
  }
  if (sessions) {
    parts.push(`sessions=${sessions.length}`);
  }
  if (roomEvents) {
    parts.push(`roomEvents=${roomEvents.length}`);
  }
  if (resourceUri) {
    parts.push(`resourceUri=${resourceUri}`);
  }

  return parts.join(" ");
};

const resourceLinksFrom = (value: unknown) => {
  if (!isRecord(value)) {
    return [];
  }

  const links: Array<{
    type: "resource_link";
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
  }> = [];
  const pushLink = ({ uri, name, title, description, mimeType }: {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
  }) => {
    if (links.length >= maxResourceLinks || links.some((link) => link.uri === uri)) {
      return;
    }
    links.push({
      type: "resource_link",
      uri,
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
    });
  };

  const resourceUri = stringValue(value.resourceUri);
  if (resourceUri) {
    pushLink({
      uri: resourceUri,
      name: "tabula-workspace",
      title: "Tabula workspace metadata",
      mimeType: "application/json",
    });
  }

  const documents = Array.isArray(value.documents) ? value.documents : [];
  for (const document of documents) {
    if (!isRecord(document)) {
      continue;
    }
    const documentResourceUri = stringValue(document.resourceUri);
    if (!documentResourceUri) {
      continue;
    }
    pushLink({
      uri: documentResourceUri,
      name: "tabula-workspace-document",
      title: stringValue(document.title) ?? "Tabula workspace document",
      description: stringValue(document.path),
      mimeType: "text/markdown",
    });
  }

  return links;
};

export const jsonContent = (value: unknown, options: JsonContentOptions = {}) => {
  const serialized = JSON.stringify(value, null, 2);
  const threshold = options.compactThresholdBytes ?? defaultCompactThresholdBytes;
  const text =
    options.summary ??
    (Buffer.byteLength(serialized, "utf8") > threshold && isRecord(value) ? summarizeObject(value) : serialized);

  return {
    content: [
      {
        type: "text" as const,
        text,
      },
      ...resourceLinksFrom(value),
    ],
    structuredContent: isRecord(value) ? value : { value },
  };
};

export const errorContent = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: error instanceof Error ? error.message : "Unknown Tabula MCP error.",
    },
  ],
});
