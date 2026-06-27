import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { createMarkdownChangeSummary, formatDocumentChangeMessage } from "./change-summary.js";
import {
  clearDocumentDraft,
  formatDraftStorageReason,
  loadDocumentDraft,
  saveDocumentDraft,
} from "./draft-storage.js";
import "./document-app.css";

const elements = {
  itemId: document.getElementById("itemId"),
  connectionStatus: document.getElementById("connectionStatus"),
  writeMode: document.getElementById("writeMode"),
  shaValue: document.getElementById("shaValue"),
  peerCount: document.getElementById("peerCount"),
  draftStatus: document.getElementById("draftStatus"),
  message: document.getElementById("message"),
  outlineList: document.getElementById("outlineList"),
  markdownEditor: document.getElementById("markdownEditor"),
  textLength: document.getElementById("textLength"),
  saveDocumentButton: document.getElementById("saveDocumentButton"),
  sendChangesButton: document.getElementById("sendChangesButton"),
  shareDocumentButton: document.getElementById("shareDocumentButton"),
  refreshButton: document.getElementById("refreshButton"),
  sendSelectionButton: document.getElementById("sendSelectionButton"),
  displayModeButton: document.getElementById("displayModeButton"),
};

const state = {
  app: null,
  mode: "idle",
  documentId: "",
  title: "",
  sessionId: "",
  roomId: "",
  sha256: "",
  lastSavedMarkdown: "",
  lastContextMarkdown: "",
  displayMode: "inline",
};

const setMessage = (text, tone = "neutral") => {
  elements.message.textContent = text;
  elements.message.dataset.tone = tone;
};

const setDraftStatus = (text, tone = "neutral") => {
  elements.draftStatus.textContent = text;
  elements.draftStatus.dataset.tone = tone;
};

const getDraftStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const shortHash = (value) => (value ? `${value.slice(0, 10)}...${value.slice(-6)}` : "-");

const getErrorText = (result) => {
  const textBlock = result?.content?.find((item) => item.type === "text");
  return textBlock?.text || "Tabula Document App could not load the current content.";
};

const updateDocumentActionState = () => {
  const isDocument = state.mode === "document" && Boolean(state.documentId);
  const hasContextChanges = isDocument && elements.markdownEditor.value !== state.lastContextMarkdown;

  elements.saveDocumentButton.disabled = !isDocument;
  elements.sendChangesButton.disabled = !hasContextChanges;
  elements.shareDocumentButton.disabled = !isDocument;
};

const extractOutline = (markdown) => {
  const headings = [];
  let offset = 0;
  const lines = markdown.split("\n");

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match?.[1] && match[2]) {
      headings.push({
        depth: match[1].length,
        text: match[2].trim(),
        line: index + 1,
        offset,
      });
    }
    offset += line.length + 1;
  }

  return headings;
};

const renderDocumentSummary = (summary) => {
  if (!summary) {
    return;
  }

  state.mode = "document";
  state.documentId = summary.documentId || state.documentId;
  state.title = summary.title || state.title;
  state.sha256 = summary.sha256 || state.sha256;

  elements.itemId.textContent = state.title || "Document";
  elements.connectionStatus.textContent = "Local";
  elements.writeMode.textContent = "Editable";
  elements.shaValue.textContent = shortHash(summary.sha256);
  elements.peerCount.textContent = "MCP";
  elements.textLength.textContent = `${summary.textLength ?? 0} chars`;
  elements.markdownEditor.readOnly = false;
  updateDocumentActionState();
};

const renderRoomSummary = (summary) => {
  if (!summary) {
    return;
  }

  state.mode = "room";
  state.sessionId = summary.sessionId || state.sessionId;
  state.roomId = summary.roomId || state.roomId;
  state.sha256 = summary.sha256 || state.sha256;

  elements.itemId.textContent = state.roomId || "Room";
  elements.connectionStatus.textContent = summary.status || "unknown";
  elements.writeMode.textContent = summary.writeAccess ? "Write-enabled" : "Read-only";
  elements.shaValue.textContent = shortHash(summary.sha256);
  elements.peerCount.textContent = String(summary.peerCount ?? 0);
  elements.textLength.textContent = `${summary.textLength ?? 0} chars`;
  setDraftStatus("Not used");
  state.lastSavedMarkdown = "";
  elements.markdownEditor.readOnly = true;
  updateDocumentActionState();
};

const renderOutline = (outline) => {
  elements.outlineList.replaceChildren();

  if (!outline?.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No headings";
    elements.outlineList.append(item);
    return;
  }

  for (const heading of outline) {
    const item = document.createElement("li");
    item.style.setProperty("--depth", String(Math.max(1, heading.depth || 1)));
    item.textContent = heading.text || "(untitled)";
    elements.outlineList.append(item);
  }
};

const applyStoredDraft = (document, savedMarkdown) => {
  const storage = getDraftStorage();
  if (!storage) {
    setDraftStatus("Unavailable", "warning");
    return {
      markdown: savedMarkdown,
      draftRestored: false,
      hasConflict: false,
      message: "",
    };
  }

  const draft = loadDocumentDraft(storage, document.documentId);
  if (!draft) {
    setDraftStatus("Saved");
    return {
      markdown: savedMarkdown,
      draftRestored: false,
      hasConflict: false,
      message: "",
    };
  }

  if (draft.markdown === savedMarkdown) {
    clearDocumentDraft(storage, document.documentId);
    setDraftStatus("Saved");
    return {
      markdown: savedMarkdown,
      draftRestored: false,
      hasConflict: false,
      message: "",
    };
  }

  const hasConflict = Boolean(draft.baseSha256 && draft.baseSha256 !== document.sha256);
  setDraftStatus(hasConflict ? "Conflict" : "Restored", "warning");

  return {
    markdown: draft.markdown,
    draftRestored: true,
    hasConflict,
    message: hasConflict
      ? "Restored a local draft that differs from the latest saved document. Review it before saving."
      : "Restored an unsaved local draft. Save to keep it in this MCP session.",
  };
};

const persistCurrentDraft = () => {
  if (state.mode !== "document" || !state.documentId) {
    return;
  }

  const storage = getDraftStorage();
  const markdown = elements.markdownEditor.value;
  if (markdown === state.lastSavedMarkdown) {
    clearDocumentDraft(storage, state.documentId);
    setDraftStatus("Saved");
    return;
  }

  const result = saveDocumentDraft(storage, {
    documentId: state.documentId,
    title: state.title,
    markdown,
    baseSha256: state.sha256,
  });

  if (!result.ok) {
    setDraftStatus(
      formatDraftStorageReason(result.reason),
      result.reason === "draft-too-large" ? "warning" : "error",
    );
    return;
  }

  setDraftStatus("Draft saved", "warning");
};

const renderSnapshot = (snapshot, options = {}) => {
  const { resetContextBaseline = true } = options;
  let markdown = snapshot.markdown || "";
  const previousContextMarkdown = state.lastContextMarkdown;
  let draftState = {
    draftRestored: false,
    hasConflict: false,
    message: "",
  };

  if (snapshot.document) {
    renderDocumentSummary(snapshot.document);
    state.lastSavedMarkdown = markdown;
    if (resetContextBaseline) {
      state.lastContextMarkdown = markdown;
    }
    draftState = applyStoredDraft(snapshot.document, markdown);
    markdown = draftState.markdown;
    if (draftState.draftRestored && previousContextMarkdown === markdown) {
      state.lastContextMarkdown = markdown;
    }
  } else {
    renderRoomSummary(snapshot.room || snapshot.status);
  }

  elements.markdownEditor.value = markdown;
  if (!snapshot.document) {
    state.lastContextMarkdown = markdown;
  }
  elements.textLength.textContent = `${markdown.length} chars`;
  renderOutline(snapshot.document ? extractOutline(markdown) : snapshot.outline || []);
  updateDocumentActionState();
  return draftState;
};

const loadSnapshot = async () => {
  if (!state.app) {
    return;
  }

  const toolRequest =
    state.mode === "document" && state.documentId
      ? {
          name: "tabula_app_document_snapshot",
          arguments: { documentId: state.documentId },
        }
      : state.mode === "room" && state.sessionId
        ? {
            name: "tabula_app_room_snapshot",
            arguments: { sessionId: state.sessionId },
          }
        : null;

  if (!toolRequest) {
    setMessage("Create a document or connect a Tabula.md room first.", "warning");
    return;
  }

  elements.refreshButton.disabled = true;
  setMessage("Refreshing Tabula.md content...");
  try {
    const result = await state.app.callServerTool(toolRequest);
    if (result.isError) {
      throw new Error(getErrorText(result));
    }

    const renderResult = renderSnapshot(result.structuredContent);
    setMessage(
      renderResult.draftRestored ? renderResult.message : "Tabula.md content is current.",
      renderResult.draftRestored ? "warning" : "neutral",
    );
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Refresh failed.", "error");
  } finally {
    elements.refreshButton.disabled = false;
  }
};

const saveDocument = async () => {
  if (!state.app || state.mode !== "document" || !state.documentId) {
    setMessage("Create a local Tabula.md document first.", "warning");
    return;
  }

  elements.saveDocumentButton.disabled = true;
  setMessage("Saving document...");
  try {
    const result = await state.app.callServerTool({
      name: "tabula_app_save_document",
      arguments: {
        documentId: state.documentId,
        markdown: elements.markdownEditor.value,
      },
    });
    if (result.isError) {
      throw new Error(getErrorText(result));
    }

    renderSnapshot(result.structuredContent, { resetContextBaseline: false });
    setMessage(
      elements.sendChangesButton.disabled
        ? "Document saved in this MCP session."
        : "Document saved in this MCP session. Send changes to update the model context.",
    );
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Save failed.", "error");
  } finally {
    updateDocumentActionState();
  }
};

const shareDocument = async () => {
  if (!state.app || state.mode !== "document" || !state.documentId) {
    setMessage("Create a local Tabula.md document first.", "warning");
    return;
  }

  elements.shareDocumentButton.disabled = true;
  elements.saveDocumentButton.disabled = true;
  setMessage("Preparing encrypted Tabula.md share link...");
  try {
    const saveResult = await state.app.callServerTool({
      name: "tabula_app_save_document",
      arguments: {
        documentId: state.documentId,
        markdown: elements.markdownEditor.value,
      },
    });
    if (saveResult.isError) {
      throw new Error(getErrorText(saveResult));
    }
    renderSnapshot(saveResult.structuredContent, { resetContextBaseline: false });

    const shareResult = await state.app.callServerTool({
      name: "tabula_share_document",
      arguments: {
        documentId: state.documentId,
      },
    });
    if (shareResult.isError) {
      throw new Error(getErrorText(shareResult));
    }

    const share = shareResult.structuredContent?.share;
    if (!share?.shareUrl) {
      throw new Error("Share tool did not return an encrypted Tabula.md link.");
    }

    await state.app.updateModelContext({
      content: [
        {
          type: "text",
          text: [
            `Encrypted Tabula.md share link for "${state.title || "Untitled Document"}":`,
            share.shareUrl,
            "",
            "Treat this URL as a bearer secret because the #key fragment can decrypt the room.",
          ].join("\n"),
        },
      ],
      structuredContent: {
        tabulaShare: share,
      },
    });
    setMessage("Encrypted share link sent to the model context.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not create encrypted share link.", "error");
  } finally {
    updateDocumentActionState();
  }
};

const sendChanges = async () => {
  if (!state.app || state.mode !== "document" || !state.documentId) {
    setMessage("Create a local Tabula.md document first.", "warning");
    return;
  }

  const currentMarkdown = elements.markdownEditor.value;
  const summary = createMarkdownChangeSummary(state.lastContextMarkdown, currentMarkdown);
  if (!summary.changed) {
    setMessage("No document changes to send.", "warning");
    updateDocumentActionState();
    return;
  }

  elements.sendChangesButton.disabled = true;
  setMessage("Sending document changes to the model context...");
  try {
    await state.app.updateModelContext({
      content: [
        {
          type: "text",
          text: formatDocumentChangeMessage({
            title: state.title,
            documentId: state.documentId,
            baseSha256: state.sha256,
            summary,
          }),
        },
      ],
      structuredContent: {
        tabulaDocumentChange: {
          mode: "document",
          documentId: state.documentId,
          title: state.title,
          baseSha256: state.sha256,
          summary,
        },
      },
    });
    state.lastContextMarkdown = currentMarkdown;
    updateDocumentActionState();
    setMessage("Document changes sent to the model context.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not send document changes.", "error");
    updateDocumentActionState();
  }
};

const getSelectedText = () => {
  if (
    document.activeElement === elements.markdownEditor &&
    elements.markdownEditor.selectionEnd > elements.markdownEditor.selectionStart
  ) {
    return elements.markdownEditor.value
      .slice(elements.markdownEditor.selectionStart, elements.markdownEditor.selectionEnd)
      .trim();
  }

  return window.getSelection()?.toString().trim() || "";
};

const sendSelection = async () => {
  const selectedText = getSelectedText();
  if (!selectedText) {
    setMessage("Select Markdown text first.", "warning");
    return;
  }

  const source =
    state.mode === "document"
      ? `document ${state.title || state.documentId}`
      : `room ${state.roomId || state.sessionId}`;

  try {
    await state.app.updateModelContext({
      content: [
        {
          type: "text",
          text: `Selected Tabula.md text from ${source} at ${state.sha256}:\n\n${selectedText}`,
        },
      ],
      structuredContent: {
        tabulaSelection: {
          mode: state.mode,
          documentId: state.documentId || undefined,
          sessionId: state.sessionId,
          roomId: state.roomId,
          sha256: state.sha256,
          text: selectedText,
        },
      },
    });
    setMessage("Selection sent to the model context.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not send selection.", "error");
  }
};

const toggleDisplayMode = async () => {
  if (!state.app) {
    return;
  }

  const requestedMode = state.displayMode === "fullscreen" ? "inline" : "fullscreen";
  try {
    const result = await state.app.requestDisplayMode({ mode: requestedMode });
    state.displayMode = result.mode || requestedMode;
    elements.displayModeButton.textContent = state.displayMode === "fullscreen" ? "Inline" : "Fullscreen";
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Display mode change failed.", "error");
  }
};

const applyHostContext = (context = {}) => {
  if (context.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.displayMode) {
    state.displayMode = context.displayMode;
    elements.displayModeButton.textContent = state.displayMode === "fullscreen" ? "Inline" : "Fullscreen";
  }
};

const boot = async () => {
  const app = new App(
    { name: "Tabula Document", version: "0.1.0" },
    { availableDisplayModes: ["inline", "fullscreen"] },
  );
  state.app = app;

  app.ontoolinput = (input) => {
    const documentId = input?.arguments?.documentId;
    const sessionId = input?.arguments?.sessionId;
    if (typeof documentId === "string") {
      state.mode = "document";
      state.documentId = documentId;
    }
    if (typeof sessionId === "string") {
      state.mode = "room";
      state.sessionId = sessionId;
    }
    setMessage(state.mode === "room" ? "Opening Tabula.md room..." : "Opening Tabula.md document...");
  };

  app.ontoolresult = (result) => {
    if (result.isError) {
      setMessage(getErrorText(result), "error");
      return;
    }

    if (result.structuredContent?.document || result.structuredContent?.markdown) {
      const renderResult = renderSnapshot(result.structuredContent);
      const readyMessage = result.structuredContent?.document ? "Tabula.md document is ready." : "Tabula.md content is ready.";
      setMessage(
        renderResult.draftRestored ? renderResult.message : readyMessage,
        renderResult.draftRestored ? "warning" : "neutral",
      );
      return;
    }

    const room = result.structuredContent?.room;
    if (room) {
      renderRoomSummary(room);
      void loadSnapshot();
    }
  };

  app.onhostcontextchanged = applyHostContext;

  elements.saveDocumentButton.addEventListener("click", () => void saveDocument());
  elements.sendChangesButton.addEventListener("click", () => void sendChanges());
  elements.shareDocumentButton.addEventListener("click", () => void shareDocument());
  elements.refreshButton.addEventListener("click", () => void loadSnapshot());
  elements.sendSelectionButton.addEventListener("click", () => void sendSelection());
  elements.displayModeButton.addEventListener("click", () => void toggleDisplayMode());
  elements.markdownEditor.addEventListener("input", () => {
    if (state.mode !== "document") {
      return;
    }

    const markdown = elements.markdownEditor.value;
    elements.textLength.textContent = `${markdown.length} chars`;
    renderOutline(extractOutline(markdown));
    persistCurrentDraft();
    updateDocumentActionState();
    setMessage("Document has unsaved changes.", "warning");
  });

  await app.connect();
  applyHostContext(app.getHostContext?.());
};

boot().catch((error) => {
  setMessage(error instanceof Error ? error.message : "Tabula Document App could not start.", "error");
});
