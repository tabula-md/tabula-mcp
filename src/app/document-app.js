import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import "./document-app.css";

const elements = {
  itemId: document.getElementById("itemId"),
  connectionStatus: document.getElementById("connectionStatus"),
  writeMode: document.getElementById("writeMode"),
  shaValue: document.getElementById("shaValue"),
  peerCount: document.getElementById("peerCount"),
  message: document.getElementById("message"),
  outlineList: document.getElementById("outlineList"),
  markdownEditor: document.getElementById("markdownEditor"),
  textLength: document.getElementById("textLength"),
  saveDocumentButton: document.getElementById("saveDocumentButton"),
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
  displayMode: "inline",
};

const setMessage = (text, tone = "neutral") => {
  elements.message.textContent = text;
  elements.message.dataset.tone = tone;
};

const shortHash = (value) => (value ? `${value.slice(0, 10)}...${value.slice(-6)}` : "-");

const getErrorText = (result) => {
  const textBlock = result?.content?.find((item) => item.type === "text");
  return textBlock?.text || "Tabula Document App could not load the current content.";
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
  elements.saveDocumentButton.disabled = false;
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
  elements.markdownEditor.readOnly = true;
  elements.saveDocumentButton.disabled = true;
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

const renderSnapshot = (snapshot) => {
  if (snapshot.document) {
    renderDocumentSummary(snapshot.document);
  } else {
    renderRoomSummary(snapshot.room || snapshot.status);
  }

  elements.markdownEditor.value = snapshot.markdown || "";
  renderOutline(snapshot.outline || []);
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

    renderSnapshot(result.structuredContent);
    setMessage("Tabula.md content is current.");
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

    renderSnapshot(result.structuredContent);
    setMessage("Document saved in this MCP session.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Save failed.", "error");
  } finally {
    elements.saveDocumentButton.disabled = state.mode !== "document";
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
      renderSnapshot(result.structuredContent);
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
    setMessage("Document has unsaved changes.", "warning");
  });

  await app.connect();
  applyHostContext(app.getHostContext?.());
};

boot().catch((error) => {
  setMessage(error instanceof Error ? error.message : "Tabula Document App could not start.", "error");
});
