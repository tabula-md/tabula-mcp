import { createTabulaMcpWebHandler } from "../src/server/web.js";

const handler = createTabulaMcpWebHandler({
  deploymentMode: "remote",
});

export const GET = (request: Request) => handler.fetch(new Request(new URL("/health", request.url), request));
export const OPTIONS = (request: Request) => handler.fetch(new Request(new URL("/health", request.url), request));
