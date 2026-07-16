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
              sessionId: roomSnapshot.room.sessionId,
            },
          });
          this.ontoolresult?.(textResult("Opened Tabula.md session.", roomSnapshot));
          return;
        }

        this.ontoolinput?.({
          arguments: {
            documentId: documentSnapshot.document.documentId,
          },
        });
        this.ontoolresult?.(textResult(`Created local Tabula.md draft "${documentSnapshot.document.title}".`, documentSnapshot));
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
        case "tabula_app_start_room_from_document": {
          roomSnapshot = {
            mode: "room",
            room: {
              sessionId: "123e4567-e89b-42d3-a456-426614174998",
              roomId: "started-from-document",
              shareUrl: "http://localhost:5173/#room=started-from-document,example-key-for-local-preview-only",
              status: "ready",
              sha256: documentSnapshot.document.sha256,
              textLength: documentSnapshot.markdown.length,
              collaboratorCount: 0,
              agentConnected: true,
              hydrationStatus: "ready",
              stateReceived: true,
            },
          };
          return textResult("Started a Tabula session. Claude is connected to the shared workspace.", roomSnapshot);
        }
        case "tabula_share_document":
          return textResult("Encrypted Tabula.md snapshot link created.", {
            share: {
              title: documentSnapshot.document.title,
              linkKind: "json-snapshot",
              snapshotId: "dev-share-snapshot",
              appOrigin: "http://localhost:5173",
              jsonServerUrl: "http://localhost:3004",
              snapshotUrl: "http://localhost:3004/api/v2/dev-share-snapshot",
              shareUrl: "http://localhost:5173/#json=dev-share-snapshot,dev-only-not-a-real-key",
              textLength: documentSnapshot.markdown.length,
              sha256: documentSnapshot.document.sha256,
              encrypted: true,
              secret: true,
              keyLocation: "url-fragment",
            },
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
