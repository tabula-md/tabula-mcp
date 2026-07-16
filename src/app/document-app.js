import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import tabulaLogoUrl from "../../assets/icon.png";
import "./document-app.css";

const elements = {
  tabulaMark: document.getElementById("tabulaMark"),
  eyebrow: document.getElementById("sessionEyebrow"),
  title: document.getElementById("sessionTitle"),
  summary: document.getElementById("sessionSummary"),
  documentMeta: document.getElementById("documentMeta"),
  collaborationMeta: document.getElementById("collaborationMeta"),
  message: document.getElementById("message"),
  openCopyButton: document.getElementById("openCopyButton"),
  startSessionButton: document.getElementById("startSessionButton"),
  openSessionButton: document.getElementById("openSessionButton"),
};

const state = {
  app: null,
  mode: "idle",
  documentId: "",
  sessionId: "",
  shareUrl: "",
  title: "",
};

const formatCount = (value) => new Intl.NumberFormat("en-US").format(Number(value) || 0);

const getErrorText = (result) => {
  const textBlock = result?.content?.find((item) => item.type === "text");
  return textBlock?.text || "Tabula.md could not prepare this handoff.";
};

const setMessage = (text, tone = "neutral") => {
  elements.message.textContent = text;
  elements.message.dataset.tone = tone;
};

const updateActionState = () => {
  const hasDocument = state.mode === "document" && Boolean(state.documentId);
  const hasSession = state.mode === "room" && Boolean(state.sessionId) && Boolean(state.shareUrl);

  elements.openCopyButton.hidden = !hasDocument;
  elements.openCopyButton.disabled = !hasDocument;
  elements.startSessionButton.hidden = !hasDocument;
  elements.startSessionButton.disabled = !hasDocument;
  elements.openSessionButton.hidden = !hasSession;
  elements.openSessionButton.disabled = !hasSession;
};

const renderDocument = (document) => {
  state.mode = "document";
  state.documentId = document.documentId || state.documentId;
  state.sessionId = "";
  state.shareUrl = "";
  state.title = document.title || state.title || "Untitled document";

  elements.eyebrow.textContent = "Private draft";
  elements.title.textContent = state.title;
  elements.summary.textContent =
    "Claude created this local Markdown draft. Open a copy to continue alone, or start a live session to collaborate in Tabula.md.";
  elements.documentMeta.textContent = `${formatCount(document.textLength)} characters · local checkpoint`;
  elements.collaborationMeta.textContent = "Not shared yet";
  updateActionState();
};

const renderRoom = (room) => {
  const peerCount = Number(room.peerCount ?? 0);
  const waitingForWorkspaceState = room.stateReceived === false;

  state.mode = "room";
  state.documentId = "";
  state.sessionId = room.sessionId || state.sessionId;
  state.shareUrl = room.shareUrl || state.shareUrl;
  state.title = room.title || state.title || "Untitled session";

  elements.eyebrow.textContent = "Live session";
  elements.title.textContent = state.title;
  elements.summary.textContent = waitingForWorkspaceState
    ? "Claude joined the encrypted session and is waiting for a collaborator to share the workspace state."
    : "This encrypted session is ready in Tabula.md. Open it to write and collaborate with people or agents.";
  elements.documentMeta.textContent = "Encrypted live session";
  elements.collaborationMeta.textContent = `${peerCount} collaborator${peerCount === 1 ? "" : "s"} connected`;
  updateActionState();
};

const renderToolResult = (result) => {
  if (result.isError) {
    setMessage(getErrorText(result), "error");
    return false;
  }

  const content = result.structuredContent;
  if (content?.document) {
    renderDocument(content.document);
    return true;
  }
  if (content?.room) {
    renderRoom(content.room);
    return true;
  }

  return false;
};

const openExternalLink = async (url, label) => {
  if (!state.app?.openLink) {
    throw new Error(`${label} is unavailable because this MCP host cannot open external links.`);
  }

  const result = await state.app.openLink({ url });
  if (result?.isError) {
    throw new Error(`${label} was blocked by this MCP host.`);
  }
};

const openCopy = async () => {
  if (!state.app || state.mode !== "document" || !state.documentId) {
    setMessage("Create a local Tabula.md draft first.", "warning");
    return;
  }

  elements.openCopyButton.disabled = true;
  elements.startSessionButton.disabled = true;
  setMessage("Preparing encrypted Tabula.md copy...");
  try {
    const result = await state.app.callServerTool({
      name: "tabula_share_document",
      arguments: { documentId: state.documentId },
    });
    if (result.isError) {
      throw new Error(getErrorText(result));
    }

    const shareUrl = result.structuredContent?.share?.shareUrl;
    if (!shareUrl) {
      throw new Error("Tabula.md did not return an encrypted copy link.");
    }

    await openExternalLink(shareUrl, "Open a copy");
    setMessage("Opened a Tabula.md copy.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not open a Tabula.md copy.", "error");
  } finally {
    updateActionState();
  }
};

const startSession = async () => {
  if (!state.app || state.mode !== "document" || !state.documentId) {
    setMessage("Create a local Tabula.md draft first.", "warning");
    return;
  }

  elements.openCopyButton.disabled = true;
  elements.startSessionButton.disabled = true;
  setMessage("Starting encrypted Tabula.md session...");
  try {
    const result = await state.app.callServerTool({
      name: "tabula_app_start_room_from_document",
      arguments: { documentId: state.documentId },
    });
    if (!renderToolResult(result)) {
      throw new Error("Tabula.md did not return a live session.");
    }

    setMessage("Tabula.md session is ready. Open session to continue in Tabula.md.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not start the Tabula.md session.", "error");
  } finally {
    updateActionState();
  }
};

const openSession = async () => {
  if (state.mode !== "room" || !state.shareUrl) {
    setMessage("Start or open a Tabula.md session first.", "warning");
    return;
  }

  elements.openSessionButton.disabled = true;
  try {
    await openExternalLink(state.shareUrl, "Open session");
    setMessage("");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not open the Tabula.md session.", "error");
  } finally {
    updateActionState();
  }
};

const applyHostContext = (context = {}) => {
  if (context.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
};

const createAppClient = () => {
  if (typeof window.__TABULA_CREATE_APP__ === "function") {
    return window.__TABULA_CREATE_APP__();
  }

  return new App(
    { name: "Tabula Session", version: "0.1.5" },
    // The editing surface is tabula.md itself. This App stays inline as a
    // compact bridge, rather than becoming a second Tabula implementation.
    { availableDisplayModes: ["inline"] },
  );
};

const boot = async () => {
  const app = createAppClient();
  state.app = app;

  app.ontoolinput = (input) => {
    if (typeof input?.arguments?.documentId === "string") {
      state.mode = "document";
      state.documentId = input.arguments.documentId;
      setMessage("Preparing Tabula.md draft...");
      return;
    }
    if (typeof input?.arguments?.sessionId === "string") {
      state.mode = "room";
      state.sessionId = input.arguments.sessionId;
      setMessage("Preparing Tabula.md session...");
    }
  };

  app.ontoolresult = (result) => {
    if (!renderToolResult(result)) {
      setMessage("Tabula.md handoff is ready.");
      return;
    }
    setMessage(state.mode === "room" ? "Tabula.md session is ready." : "Tabula.md draft is ready.");
  };

  app.onhostcontextchanged = applyHostContext;

  elements.openCopyButton.addEventListener("click", () => void openCopy());
  elements.startSessionButton.addEventListener("click", () => void startSession());
  elements.openSessionButton.addEventListener("click", () => void openSession());
  elements.tabulaMark.src = tabulaLogoUrl;
  updateActionState();

  await app.connect();
  applyHostContext(app.getHostContext?.());
};

boot().catch((error) => {
  setMessage(error instanceof Error ? error.message : "Tabula.md could not start.", "error");
});
