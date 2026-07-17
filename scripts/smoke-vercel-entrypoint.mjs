import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mcp = await import("../api/mcp.ts");
const health = await import("../api/health.ts");
const ready = await import("../api/ready.ts");

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const fetchImpl = (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const pathname = new URL(request.url).pathname;

  if (pathname === "/health" || pathname === "/api/health") {
    if (request.method === "GET") {
      return health.GET(request);
    }
    if (request.method === "OPTIONS") {
      return health.OPTIONS(request);
    }
  }

  if (pathname === "/ready" || pathname === "/api/ready") {
    if (request.method === "GET") {
      return ready.GET(request);
    }
    if (request.method === "OPTIONS") {
      return ready.OPTIONS(request);
    }
  }

  const handler = {
    DELETE: mcp.DELETE,
    GET: mcp.GET,
    OPTIONS: mcp.OPTIONS,
    POST: mcp.POST,
  }[request.method];
  if (!handler) {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return handler(request);
};

const healthResponse = await fetchImpl(new Request("https://mcp.example.com/health"));
assert(healthResponse.status === 200, `Vercel health returned ${healthResponse.status}`);
const healthBody = await healthResponse.json();
assert(healthBody.service === "tabula-mcp", "Vercel health did not identify tabula-mcp");
assert(healthBody.version === "0.4.0", "Vercel health did not expose the package version");
assert(healthBody.writeAccess === "enabled", "Vercel health did not expose the write policy");
assert(healthBody.deploymentMode === "remote", "Vercel health did not use remote deployment mode");

const readyResponse = await fetchImpl(new Request("https://mcp.example.com/ready"));
assert(readyResponse.status === 200, `Vercel ready returned ${readyResponse.status}`);
const readyBody = await readyResponse.json();
assert(readyBody.service === "tabula-mcp", "Vercel ready did not identify tabula-mcp");
assert(readyBody.version === "0.4.0", "Vercel ready did not expose the package version");
assert(readyBody.writeAccess === "enabled", "Vercel ready did not expose the write policy");

const client = new Client({ name: "tabula-mcp-vercel-smoke", version: "0.0.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
      fetch: fetchImpl,
    }),
  );
  const tools = await client.listTools();
  assert(JSON.stringify(tools.tools.map((tool) => tool.name)) === JSON.stringify([
    "tabula_start_session",
    "tabula_join_room",
    "tabula_list_files",
    "tabula_read_files",
    "tabula_search_files",
    "tabula_write_file",
    "tabula_write_files",
    "tabula_export_copy",
  ]), "Vercel MCP endpoint did not expose exactly the eight core tools");
} finally {
  await client.close();
}

console.log("Vercel MCP entrypoint smoke passed");
