import { copyFixture, roomFixture } from "./fixtures.js";

const clone = (value) => structuredClone(value);

const params = () => new URLSearchParams(window.location.search);
const getFixtureMode = () => params().get("fixture") || "copy";

const textResult = (text, structuredContent) => ({
  content: [{ type: "text", text }],
  structuredContent,
});

const emitDevEvent = (name, detail) => {
  window.dispatchEvent(new CustomEvent(`tabula-dev:${name}`, { detail }));
};

export const shouldUseDevBridge = () => {
  const query = params();
  return query.has("tabula-dev") || window.location.pathname.endsWith("index-dev.html");
};

export const createDevApp = () => ({
  ontoolinput: undefined,
  ontoolresult: undefined,
  onhostcontextchanged: undefined,

  async connect() {
    this.onhostcontextchanged?.(this.getHostContext());
    queueMicrotask(() => {
      if (getFixtureMode() === "session") {
        this.ontoolinput?.({ arguments: { files: [{ path: "brief.md", content: "# Brief\n" }] } });
        this.ontoolresult?.(textResult("Started a live Tabula session.", clone(roomFixture)));
        return;
      }
      this.ontoolinput?.({ arguments: { files: [{ path: "brief.md", content: "# Brief\n" }] } });
      this.ontoolresult?.(textResult("Created an encrypted Tabula copy.", clone(copyFixture)));
    });
  },

  getHostContext() {
    return {
      platform: "desktop",
      theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    };
  },

  getHostCapabilities() {
    return params().get("open-links") === "unsupported" ? {} : { openLinks: {} };
  },

  async openLink(request) {
    emitDevEvent("open-link", request);
    return params().get("open-links") === "deny" ? { isError: true } : {};
  },
});
