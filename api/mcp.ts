import { readFileSync } from "node:fs";
import path from "node:path";
import { createTabulaMcpWebHandler } from "../src/server/web.js";

export const config = {
  maxDuration: 60,
};

const documentAppHtml = readFileSync(path.join(process.cwd(), "dist", "document-app.html"), "utf8");
const handler = createTabulaMcpWebHandler({
  deploymentMode: "remote",
  documentAppHtml,
});

export const GET = (request: Request) => handler.fetch(request);
export const POST = (request: Request) => handler.fetch(request);
export const DELETE = (request: Request) => handler.fetch(request);
export const OPTIONS = (request: Request) => handler.fetch(request);
