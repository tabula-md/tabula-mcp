import { readFile } from "node:fs/promises";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TabulaMcpError } from "../protocol.js";
import { documentAppHtmlFilename, tabulaDocumentAppResourceUri } from "./types.js";

const readDocumentAppHtml = async () => {
  const candidateUrls = [
    new URL(`./${documentAppHtmlFilename}`, import.meta.url),
    new URL(`../${documentAppHtmlFilename}`, import.meta.url),
    new URL(`../../dist/${documentAppHtmlFilename}`, import.meta.url),
  ];

  for (const url of candidateUrls) {
    try {
      return await readFile(url, "utf8");
    } catch {
      // Try the next runtime layout.
    }
  }

  throw new TabulaMcpError("Tabula Document App asset is missing. Run npm run build:app before opening the MCP App.");
};

export const registerDocumentAppResource = (server: McpServer) => {
  registerAppResource(
    server,
    "Tabula Document App",
    tabulaDocumentAppResourceUri,
    {
      description: "Interactive Markdown document editor and read-only room view for Tabula.md.",
      _meta: {
        ui: {
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: tabulaDocumentAppResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readDocumentAppHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {},
            },
          },
        },
      ],
    }),
  );
};
