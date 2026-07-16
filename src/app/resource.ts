import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TabulaMcpError } from "../protocol.js";
import { documentAppHtmlFilename } from "./types.js";

const readDocumentAppHtml = () => {
  const candidateUrls = [
    new URL(`../../dist/${documentAppHtmlFilename}`, import.meta.url),
    new URL(`../${documentAppHtmlFilename}`, import.meta.url),
    new URL(`./${documentAppHtmlFilename}`, import.meta.url),
  ];

  for (const url of candidateUrls) {
    try {
      return readFileSync(url, "utf8");
    } catch {
      // Try the next runtime layout.
    }
  }

  throw new TabulaMcpError("Tabula Document App asset is missing. Run npm run build:app before opening the MCP App.");
};

export type RegisterDocumentAppResourceOptions = {
  documentAppHtml?: string;
};

export type DocumentAppResource = {
  html: string;
  uri: string;
};

export const createDocumentAppResource = (
  { documentAppHtml }: RegisterDocumentAppResourceOptions = {},
): DocumentAppResource => {
  const html = documentAppHtml ?? readDocumentAppHtml();
  const fingerprint = createHash("sha256").update(html).digest("hex").slice(0, 16);

  return {
    html,
    // MCP hosts cache App resources by URI. Fingerprinting the bundled HTML
    // makes every changed local MCPB App a distinct resource without asking a
    // developer to clear Claude's cache.
    uri: `ui://tabula/document-${fingerprint}.html`,
  };
};

export const registerDocumentAppResource = (
  server: McpServer,
  resource: DocumentAppResource,
) => {
  registerAppResource(
    server,
    "Tabula Session Card",
    resource.uri,
    {
      description: "A compact handoff from Claude to the actual Tabula.md document or live session.",
      _meta: {
        ui: {
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: resource.uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: resource.html,
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
