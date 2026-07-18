import { TabulaMcpError } from "./protocol.js";

export const maxMarkdownFileBytes = 5 * 1024 * 1024;

export const assertMarkdownSize = (markdown: string) => {
  if (new TextEncoder().encode(markdown).byteLength > maxMarkdownFileBytes) {
    throw new TabulaMcpError("Tabula Markdown files are limited to 5 MiB each.");
  }
};
