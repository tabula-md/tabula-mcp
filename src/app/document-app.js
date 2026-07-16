import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import tabulaLogoUrl from "../../assets/icon.png";
import "./document-app.css";

const elements = {
  tabulaMark: document.getElementById("tabulaMark"),
  eyebrow: document.getElementById("sessionEyebrow"),
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
  draftId: "",
  sessionId: "",
  sessionUrl: "",
  pendingSessionUrl: "",
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
  const hasDocument = state.mode === "document" && Boolean(state.draftId);
  const hasSession = state.mode === "room" && Boolean(state.sessionId);

  elements.openCopyButton.hidden = !hasDocument && !hasSession;
  elements.openCopyButton.disabled = !hasDocument && !hasSession;
  elements.openCopyButton.textContent = hasSession ? "Export copy" : "Open a copy";
  elements.startSessionButton.hidden = !hasDocument;
  elements.startSessionButton.disabled = !hasDocument;
  elements.openSessionButton.hidden = !hasSession || !state.sessionUrl;
  elements.openSessionButton.disabled = !hasSession || !state.sessionUrl;
};

const renderDocument = (draft) => {
  state.mode = "document";
  state.draftId = draft.draftId || state.draftId;
  state.sessionId = "";
  state.sessionUrl = "";

  elements.eyebrow.textContent = "Private draft";
  elements.summary.textContent =
    "This draft stays on this device until you open a copy or start a shared session.";
  elements.documentMeta.textContent = `${formatCount(draft.textLength)} characters · private draft`;
  elements.collaborationMeta.textContent = "Not shared yet";
  updateActionState();
};

const renderRoom = (session) => {
  const collaboratorCount = Number(session.otherCollaboratorCount ?? 0);
  const waitingForWorkspaceState = session.ready === false;

  state.mode = "room";
  state.draftId = "";
  state.sessionId = session.sessionId || state.sessionId;
  state.sessionUrl = session.sessionUrl || state.pendingSessionUrl || state.sessionUrl;
  state.pendingSessionUrl = "";

  elements.eyebrow.textContent = "Shared session";
  elements.summary.textContent = waitingForWorkspaceState
    ? "Claude is connected to this session and is waiting for workspace state."
    : "Claude is connected to this shared workspace. Claude Desktop asks before it applies changes.";
  elements.documentMeta.textContent = "Encrypted live session";
  elements.collaborationMeta.textContent = `Claude is connected · ${collaboratorCount} other collaborator${collaboratorCount === 1 ? "" : "s"}`;
  updateActionState();
};

const renderToolResult = (result) => {
  if (result.isError) {
    state.pendingSessionUrl = "";
    setMessage(getErrorText(result), "error");
    return false;
  }

  const content = result.structuredContent;
  if (content?.draftId) {
    renderDocument(content);
    return true;
  }
  if (content?.sessionId && typeof content?.ready === "boolean") {
    renderRoom(content);
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
  if (!state.app || (state.mode !== "document" && state.mode !== "room")) {
    setMessage("Create a draft or join a Tabula session first.", "warning");
    return;
  }

  elements.openCopyButton.disabled = true;
  elements.startSessionButton.disabled = true;
  setMessage("Preparing encrypted Tabula.md copy...");
  try {
    const result = await state.app.callServerTool({
      name: "tabula_export_copy",
      arguments: {
        source: state.mode === "document"
          ? { kind: "draft", draftId: state.draftId }
          : { kind: "session", sessionId: state.sessionId },
      },
    });
    if (result.isError) {
      throw new Error(getErrorText(result));
    }

    const shareUrl = result.structuredContent?.copyUrl;
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
  if (!state.app || state.mode !== "document" || !state.draftId) {
    setMessage("Create a local Tabula.md draft first.", "warning");
    return;
  }

  elements.openCopyButton.disabled = true;
  elements.startSessionButton.disabled = true;
  setMessage("Starting encrypted Tabula.md session...");
  try {
    const result = await state.app.callServerTool({
      name: "tabula_start_session",
      arguments: { draftId: state.draftId },
    });
    if (!renderToolResult(result)) {
      throw new Error("Tabula.md did not return a live session.");
    }

    setMessage("Shared session is ready. Claude is connected to it.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not start the Tabula.md session.", "error");
  } finally {
    updateActionState();
  }
};

const openSession = async () => {
  if (state.mode !== "room" || !state.sessionUrl) {
    setMessage("Start or open a Tabula.md session first.", "warning");
    return;
  }

  elements.openSessionButton.disabled = true;
  try {
    await openExternalLink(state.sessionUrl, "Open session");
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
    { name: "Tabula Session", version: "0.2.2" },
    // The editing surface is tabula.md itself. This App stays inline as a
    // compact bridge, rather than becoming a second Tabula implementation.
    { availableDisplayModes: ["inline"] },
  );
};

const boot = async () => {
  const app = createAppClient();
  state.app = app;

  app.ontoolinput = (input) => {
    if (typeof input?.arguments?.draftId === "string") {
      state.mode = "document";
      state.draftId = input.arguments.draftId;
      setMessage("Preparing Tabula.md draft...");
      return;
    }
    if (typeof input?.arguments?.roomUrl === "string") {
      state.pendingSessionUrl = input.arguments.roomUrl;
      setMessage("Preparing Tabula.md session...");
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
