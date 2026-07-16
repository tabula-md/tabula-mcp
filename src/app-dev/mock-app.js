import { documentFixture, roomFixture } from "./fixtures.js";

const clone = (value) => structuredClone(value);

const getFixtureMode = () => new URLSearchParams(window.location.search).get("fixture") || "document";

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

const createDocumentSnapshot = (snapshot, markdown, title) => {
  const outline = extractOutline(markdown);
  return {
    document: {
      ...snapshot.document,
      title,
      textLength: markdown.length,
      sha256: `dev-${markdown.length}-${outline.length}`,
      updatedAt: new Date().toISOString(),
      outlineCount: outline.length,
    },
    markdown,
    outline,
  };
};

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
  let displayMode = "inline";
  let documentSnapshot = clone(documentFixture);
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
          this.ontoolresult?.(
            textResult(`Opening Tabula Room View for room ${roomSnapshot.room.roomId}.`, {
              mode: "room",
              room: roomSnapshot.room,
            }),
          );
          return;
        }

        this.ontoolinput?.({
          arguments: {
            documentId: documentSnapshot.document.documentId,
          },
        });
        this.ontoolresult?.(
          textResult(`Opening Tabula.md document "${documentSnapshot.document.title}".`, {
            ...documentSnapshot,
            resourceUri: "ui://tabula/document.html",
          }),
        );
      });
    },

    getHostContext() {
      return {
        displayMode,
        platform: "desktop",
        theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      };
    },

    async callServerTool(request) {
      emitDevEvent("tool-call", request);
      switch (request?.name) {
        case "tabula_app_document_snapshot":
          return textResult("Tabula document snapshot loaded.", documentSnapshot);
        case "tabula_app_room_snapshot":
          return textResult("Tabula room snapshot loaded.", roomSnapshot);
        case "tabula_app_save_document": {
          const markdown = String(request.arguments?.markdown ?? "");
          const title = String(request.arguments?.title || documentSnapshot.document.title || "Untitled Document");
          documentSnapshot = createDocumentSnapshot(documentSnapshot, markdown, title);
          return textResult("Tabula document saved in the local MCP session.", documentSnapshot);
        }
        case "tabula_app_start_room_from_document": {
          roomSnapshot = {
            mode: "room",
            room: {
              sessionId: "123e4567-e89b-42d3-a456-426614174998",
              roomId: "started-from-document",
              shareUrl: "http://localhost:5173/#room=started-from-document,example-key-for-local-preview-only",
              status: "connected",
              writeAccess: false,
              sha256: documentSnapshot.document.sha256,
              textLength: documentSnapshot.markdown.length,
              peerCount: 0,
              hydrationStatus: "ready",
              stateReceived: true,
            },
            markdown: documentSnapshot.markdown,
            outline: documentSnapshot.outline,
          };
          return textResult("Started Tabula session.", roomSnapshot);
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

    async updateModelContext(payload) {
      emitDevEvent("model-context", payload);
      console.info("[tabula-dev] updateModelContext", payload);
      return {};
    },

    async openLink(request) {
      emitDevEvent("open-link", request);
      console.info("[tabula-dev] openLink", request);
      return {};
    },

    async requestDisplayMode(request) {
      displayMode = request?.mode === "fullscreen" ? "fullscreen" : "inline";
      emitDevEvent("display-mode", { mode: displayMode });
      this.onhostcontextchanged?.(this.getHostContext());
      return {
        mode: displayMode,
      };
    },
  };
};
