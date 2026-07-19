import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import tabulaLogoUrl from "../../assets/icon.png";
import "./document-app.css";

const elements = {
  tabulaMark: document.getElementById("tabulaMark"),
  eyebrow: document.getElementById("handoffEyebrow"),
  meta: document.getElementById("handoffMeta"),
  message: document.getElementById("message"),
  openButton: document.getElementById("openButton"),
};

const state = {
  app: null,
  mode: "idle",
  targetUrl: "",
  canOpenLinks: null,
};

const hostColorMappings = {
  "--tabula-bg": "--color-background-primary",
  "--tabula-text": "--color-text-primary",
  "--tabula-muted": "--color-text-secondary",
  "--tabula-border": "--color-border-primary",
};

const formatCount = (value) => new Intl.NumberFormat("en-US").format(Number(value) || 0);

const getErrorText = (result) => {
  const structuredMessage = result?.structuredContent?.message;
  if (typeof structuredMessage === "string") {
    return structuredMessage;
  }
  const textBlock = result?.content?.find((item) => item.type === "text");
  const text = textBlock?.text;
  if (!text) {
    return "Tabula could not prepare this handoff.";
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.message === "string" ? parsed.message : "Tabula could not prepare this handoff.";
  } catch {
    return text;
  }
};

const setMessage = (text, tone = "neutral") => {
  elements.message.textContent = text;
  elements.message.title = text;
  elements.message.dataset.tone = tone;
};

const updateActionState = () => {
  const ready = Boolean(state.targetUrl) && (state.mode === "copy" || state.mode === "session");
  elements.openButton.hidden = !ready;
  elements.openButton.disabled = !ready || state.canOpenLinks === false;
  elements.openButton.textContent = state.mode === "session" ? "Open session" : "Open copy";
};

const fileLabel = (fileCount) => `${formatCount(fileCount)} file${Number(fileCount) === 1 ? "" : "s"}`;

const renderCopy = (copy) => {
  state.mode = "copy";
  state.targetUrl = copy.copyUrl || "";
  elements.eyebrow.textContent = "Encrypted copy";
  elements.meta.textContent = fileLabel(copy.fileCount);
  updateActionState();
};

const renderSession = (session) => {
  state.mode = "session";
  state.targetUrl = session.sessionUrl || "";
  elements.eyebrow.textContent = "Live session";
  elements.meta.textContent = fileLabel(session.fileCount);
  updateActionState();
};

const renderToolResult = (result) => {
  if (result.isError) {
    state.mode = "idle";
    state.targetUrl = "";
    elements.eyebrow.textContent = "Handoff failed";
    elements.meta.textContent = "";
    updateActionState();
    setMessage(getErrorText(result), "error");
    return false;
  }

  const content = result.structuredContent;
  if (typeof content?.copyUrl === "string") {
    renderCopy(content);
    return true;
  }
  if (typeof content?.sessionUrl === "string") {
    renderSession(content);
    return true;
  }

  return false;
};

const openTarget = async () => {
  if (!state.app || !state.targetUrl) {
    return;
  }
  if (state.canOpenLinks === false || !state.app.openLink) {
    setMessage("Cannot open links", "warning");
    return;
  }

  elements.openButton.disabled = true;
  setMessage("Awaiting approval");
  try {
    const result = await state.app.openLink({ url: state.targetUrl });
    if (result?.isError) {
      setMessage("Not approved", "warning");
      return;
    }
    setMessage("Opened");
  } catch {
    setMessage("Could not open", "warning");
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
    for (const [target, source] of Object.entries(hostColorMappings)) {
      const value = context.styles.variables[source];
      if (typeof value === "string" && value.trim()) {
        document.documentElement.style.setProperty(target, value);
      }
    }
  }
};

const createAppClient = () => {
  if (typeof window.__TABULA_CREATE_APP__ === "function") {
    return window.__TABULA_CREATE_APP__();
  }

  return new App(
    { name: "Tabula Handoff", version: "0.8.1" },
    { availableDisplayModes: ["inline"] },
  );
};

const boot = async () => {
  const app = createAppClient();
  state.app = app;

  app.ontoolinput = () => {
    setMessage("Preparing");
  };

  app.ontoolresult = (result) => {
    if (!renderToolResult(result)) {
      if (!result.isError) {
        setMessage("Tabula did not return a handoff link.", "error");
      }
      return;
    }
    setMessage("");
  };

  app.onhostcontextchanged = applyHostContext;

  elements.openButton.addEventListener("click", () => void openTarget());
  elements.tabulaMark.src = tabulaLogoUrl;
  updateActionState();

  await app.connect();
  applyHostContext(app.getHostContext?.());
  state.canOpenLinks = app.getHostCapabilities?.()?.openLinks !== undefined;
  if (state.canOpenLinks === false && state.targetUrl) {
    setMessage("Cannot open links", "warning");
  }
  updateActionState();
};

boot().catch((error) => {
  setMessage(error instanceof Error ? error.message : "Tabula could not start.", "error");
});
