import { documentFixture, roomFixture } from "./fixtures.js";

const clone = (value) => structuredClone(value);

const getFixtureMode = () => new URLSearchParams(window.location.search).get("fixture") || "document";

const textResult = (text, structuredContent) => ({
  content: [
    {
      type: "text",
      text,
    },
  ],
  structuredContent,
});

const toolError = (text) => ({
  isError: true,
  content: [
    {
      type: "text",
      text,
    },
  ],
});

const emitDevEvent = (name, detail) => {
  window.dispatchEvent(new CustomEvent(`tabula-dev:${name}`, { detail }));
};

export const shouldUseDevBridge = () => {
  const params = new URLSearchParams(window.location.search);
  return params.has("tabula-dev") || window.location.pathname.endsWith("index-dev.html");
};

export const createDevApp = () => {
  const documentSnapshot = clone(documentFixture);
  let roomSnapshot = clone(roomFixture);

  return {
    ontoolinput: undefined,
    ontoolresult: undefined,
    onhostcontextchanged: undefined,

    async connect() {
      this.onhostcontextchanged?.(this.getHostContext());
      queueMicrotask(() => {
        if (getFixtureMode() === "room") {
          this.ontoolinput?.({
            arguments: {
              sessionId: roomSnapshot.sessionId,
              roomUrl: roomSnapshot.sessionUrl,
            },
          });
          this.ontoolresult?.(textResult("Opened Tabula.md session.", roomSnapshot));
          return;
        }

        this.ontoolinput?.({
          arguments: {
            draftId: documentSnapshot.draftId,
          },
        });
        this.ontoolresult?.(textResult(`Created private draft "${documentSnapshot.title}".`, documentSnapshot));
      });
    },

    getHostContext() {
      return {
        platform: "desktop",
        theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      };
    },

    async callServerTool(request) {
      emitDevEvent("tool-call", request);
      switch (request?.name) {
        case "tabula_start_session": {
          roomSnapshot = {
            sessionId: "123e4567-e89b-42d3-a456-426614174998",
            sessionUrl: "http://localhost:5173/#room=started-from-document,example-key-for-local-preview-only",
            ready: true,
            canWrite: true,
            fileCount: 1,
            otherCollaboratorCount: 0,
          };
          return textResult("Started a Tabula session. Claude is connected to the shared workspace.", roomSnapshot);
        }
        case "tabula_export_copy":
          return textResult("Encrypted Tabula.md snapshot link created.", {
            copyUrl: "http://localhost:5173/#json=dev-share-snapshot,dev-only-not-a-real-key",
            fileCount: 1,
            encrypted: true,
            createdAt: "2026-07-17T00:00:00.000Z",
          });
        default:
          return toolError(`Unknown dev harness tool: ${request?.name || "missing"}`);
      }
    },

    async openLink(request) {
      emitDevEvent("open-link", request);
      return {};
    },
  };
};
