import documentAppHtml from "../dist/document-app.html";
import { createTabulaMcpWebHandler, type TabulaMcpWebHandler, type WebEnvironment } from "../src/server/web.js";

let handler: TabulaMcpWebHandler | null = null;

const stringEnv = (env: Record<string, unknown>): WebEnvironment =>
  Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key, value]),
  );

export default {
  fetch(request: Request, env: Record<string, unknown>) {
    handler ??= createTabulaMcpWebHandler({
      deploymentMode: "remote",
      documentAppHtml,
      env: stringEnv(env),
    });
    return handler.fetch(request);
  },
};
