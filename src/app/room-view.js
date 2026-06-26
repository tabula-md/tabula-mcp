import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import "./room-view.css";

const elements = {
  roomId: document.getElementById("roomId"),
  connectionStatus: document.getElementById("connectionStatus"),
  writeMode: document.getElementById("writeMode"),
  shaValue: document.getElementById("shaValue"),
  peerCount: document.getElementById("peerCount"),
  message: document.getElementById("message"),
  outlineList: document.getElementById("outlineList"),
  markdownPreview: document.getElementById("markdownPreview"),
  textLength: document.getElementById("textLength"),
  refreshButton: document.getElementById("refreshButton"),
  sendSelectionButton: document.getElementById("sendSelectionButton"),
  displayModeButton: document.getElementById("displayModeButton"),
};

const state = {
  app: null,
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
  return textBlock?.text || "Tabula Room View could not load the room.";
};

const renderSummary = (summary) => {
  if (!summary) {
    return;
  }

  state.sessionId = summary.sessionId || state.sessionId;
  state.roomId = summary.roomId || state.roomId;
  state.sha256 = summary.sha256 || state.sha256;

  elements.roomId.textContent = state.roomId || "Room View";
  elements.connectionStatus.textContent = summary.status || "unknown";
  elements.writeMode.textContent = summary.writeAccess ? "Write-enabled" : "Read-only";
  elements.shaValue.textContent = shortHash(summary.sha256);
  elements.peerCount.textContent = String(summary.peerCount ?? 0);
  elements.textLength.textContent = `${summary.textLength ?? 0} chars`;
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
  renderSummary(snapshot.status);
  elements.markdownPreview.textContent = snapshot.markdown || "";
  renderOutline(snapshot.outline || []);
};

const loadSnapshot = async () => {
  if (!state.app || !state.sessionId) {
    setMessage("Connect a Tabula.md room first.", "warning");
    return;
  }

  elements.refreshButton.disabled = true;
  setMessage("Refreshing room view...");
  try {
    const result = await state.app.callServerTool({
      name: "tabula_app_room_snapshot",
      arguments: { sessionId: state.sessionId },
    });
    if (result.isError) {
      throw new Error(getErrorText(result));
    }

    renderSnapshot(result.structuredContent);
    setMessage("Room view is current.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Refresh failed.", "error");
  } finally {
    elements.refreshButton.disabled = false;
  }
};

const sendSelection = async () => {
  const selectedText = window.getSelection()?.toString().trim() || "";
  if (!selectedText) {
    setMessage("Select Markdown text first.", "warning");
    return;
  }

  try {
    await state.app.updateModelContext({
      content: [
        {
          type: "text",
          text: `Selected Tabula.md text from room ${state.roomId || state.sessionId} at ${state.sha256}:\n\n${selectedText}`,
        },
      ],
      structuredContent: {
        tabulaSelection: {
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
    { name: "Tabula Room View", version: "0.1.0" },
    { availableDisplayModes: ["inline", "fullscreen"] },
  );
  state.app = app;

  app.ontoolinput = (input) => {
    const sessionId = input?.arguments?.sessionId;
    if (typeof sessionId === "string") {
      state.sessionId = sessionId;
    }
    setMessage("Opening Tabula.md room view...");
  };

  app.ontoolresult = (result) => {
    if (result.isError) {
      setMessage(getErrorText(result), "error");
      return;
    }

    const summary = result.structuredContent?.room;
    if (summary) {
      renderSummary(summary);
      void loadSnapshot();
    }
  };

  app.onhostcontextchanged = applyHostContext;

  elements.refreshButton.addEventListener("click", () => void loadSnapshot());
  elements.sendSelectionButton.addEventListener("click", () => void sendSelection());
  elements.displayModeButton.addEventListener("click", () => void toggleDisplayMode());

  await app.connect();
  applyHostContext(app.getHostContext?.());
};

boot().catch((error) => {
  setMessage(error instanceof Error ? error.message : "Tabula Room View could not start.", "error");
});
