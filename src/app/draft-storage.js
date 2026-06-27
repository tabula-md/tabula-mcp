export const draftStoragePrefix = "tabula.md:mcp:draft:v1:";
export const draftStorageIndexKey = `${draftStoragePrefix}index`;
export const defaultMaxDraftBytes = 2 * 1024 * 1024;
export const defaultMaxDraftEntries = 20;

const documentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const utf8ByteLength = (text) => new TextEncoder().encode(text).byteLength;

const parseJson = (value) => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export const isValidDocumentId = (documentId) =>
  typeof documentId === "string" && documentIdPattern.test(documentId);

export const documentDraftStorageKey = (documentId) =>
  isValidDocumentId(documentId) ? `${draftStoragePrefix}${documentId}` : null;

const normalizeIndex = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isValidDocumentId(item?.documentId) && typeof item.updatedAt === "string")
    .map((item) => ({
      documentId: item.documentId,
      updatedAt: item.updatedAt,
    }));
};

export const readDraftIndex = (storage) => {
  try {
    return normalizeIndex(parseJson(storage?.getItem(draftStorageIndexKey)));
  } catch {
    return [];
  }
};

const writeDraftIndex = (storage, index) => {
  storage.setItem(draftStorageIndexKey, JSON.stringify(index));
};

const removeDocumentDraftWithoutIndex = (storage, documentId) => {
  const key = documentDraftStorageKey(documentId);
  if (key) {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore storage failures; draft recovery is best-effort.
    }
  }
};

const pruneDrafts = (storage, index, maxDraftEntries) => {
  const sortedIndex = [...index].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const kept = sortedIndex.slice(0, maxDraftEntries);
  const keptIds = new Set(kept.map((item) => item.documentId));

  for (const item of sortedIndex) {
    if (!keptIds.has(item.documentId)) {
      removeDocumentDraftWithoutIndex(storage, item.documentId);
    }
  }

  try {
    writeDraftIndex(storage, kept);
  } catch {
    // Ignore index write failures; individual draft writes still determine recovery.
  }
  return kept;
};

const rememberDraft = (storage, draft, maxDraftEntries) => {
  const nextIndex = [
    { documentId: draft.documentId, updatedAt: draft.updatedAt },
    ...readDraftIndex(storage).filter((item) => item.documentId !== draft.documentId),
  ];

  pruneDrafts(storage, nextIndex, maxDraftEntries);
};

export const createDocumentDraft = (input, options = {}) => {
  const documentId = input?.documentId;
  const key = documentDraftStorageKey(documentId);
  if (!key) {
    return { ok: false, reason: "invalid-document-id" };
  }

  const markdown = String(input.markdown ?? "");
  const byteLength = utf8ByteLength(markdown);
  const maxDraftBytes = options.maxDraftBytes ?? defaultMaxDraftBytes;
  if (byteLength > maxDraftBytes) {
    return {
      ok: false,
      reason: "draft-too-large",
      byteLength,
      maxDraftBytes,
    };
  }

  return {
    ok: true,
    key,
    draft: {
      version: 1,
      documentId,
      title: String(input.title || "Untitled Document"),
      markdown,
      baseSha256: String(input.baseSha256 || ""),
      updatedAt: input.updatedAt || new Date().toISOString(),
      textLength: markdown.length,
      byteLength,
    },
  };
};

export const loadDocumentDraft = (storage, documentId) => {
  const key = documentDraftStorageKey(documentId);
  if (!storage || !key) {
    return null;
  }

  let value;
  try {
    value = parseJson(storage.getItem(key));
  } catch {
    return null;
  }

  if (
    !value ||
    value.version !== 1 ||
    value.documentId !== documentId ||
    typeof value.markdown !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    clearDocumentDraft(storage, documentId);
    return null;
  }

  return value;
};

export const clearDocumentDraft = (storage, documentId) => {
  const key = documentDraftStorageKey(documentId);
  if (!storage || !key) {
    return;
  }

  try {
    storage.removeItem(key);
    writeDraftIndex(
      storage,
      readDraftIndex(storage).filter((item) => item.documentId !== documentId),
    );
  } catch {
    // Ignore storage failures; draft recovery is best-effort.
  }
};

export const saveDocumentDraft = (storage, input, options = {}) => {
  if (!storage) {
    return { ok: false, reason: "storage-unavailable" };
  }

  const created = createDocumentDraft(input, options);
  if (!created.ok) {
    return created;
  }

  const maxDraftEntries = options.maxDraftEntries ?? defaultMaxDraftEntries;
  const serializedDraft = JSON.stringify(created.draft);

  try {
    storage.setItem(created.key, serializedDraft);
  } catch {
    const prunedIndex = pruneDrafts(storage, readDraftIndex(storage), Math.max(1, Math.floor(maxDraftEntries / 2)));
    try {
      storage.setItem(created.key, serializedDraft);
      writeDraftIndex(storage, prunedIndex);
    } catch {
      return { ok: false, reason: "storage-unavailable" };
    }
  }

  try {
    rememberDraft(storage, created.draft, maxDraftEntries);
  } catch {
    // Ignore index write failures after the draft itself was saved.
  }
  return { ok: true, draft: created.draft };
};

export const formatDraftStorageReason = (reason) => {
  switch (reason) {
    case "draft-too-large":
      return "Draft is too large for local recovery";
    case "invalid-document-id":
      return "Draft recovery skipped for this document";
    case "storage-unavailable":
      return "Draft recovery is unavailable";
    default:
      return "Draft recovery failed";
  }
};
