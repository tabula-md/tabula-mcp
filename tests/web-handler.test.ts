import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { TABULA_MCP_PRODUCT_DESCRIPTION } from "../src/public-copy.js";
import { createTabulaMcpWebHandler } from "../src/server/web.js";

const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

describe("Tabula MCP Web handler", () => {
  it("describes the hosted product at the service root", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
    });
    const response = await handler.fetch(new Request("https://mcp.example.com/"));

    await expect(response.json()).resolves.toMatchObject({
      description: TABULA_MCP_PRODUCT_DESCRIPTION,
    });
  });

  it("serves health metadata for serverless deployment targets", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
      writeEnabled: true,
    });
    const response = await handler.fetch(new Request("https://mcp.example.com/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "tabula-mcp",
      version: "0.8.0",
      writeAccess: "enabled",
      deploymentMode: "remote",
    });
    expect(handler.version).toBe("0.8.0");
    expect(handler.writeAccess).toBe("enabled");
  });

  it("serves readiness metadata without claiming a plaintext checkpoint store", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
    });
    const response = await handler.fetch(new Request("https://mcp.example.com/ready"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "tabula-mcp",
      version: "0.8.0",
      writeAccess: "enabled",
      deploymentMode: "remote",
    });
  });

  it("accepts Streamable HTTP MCP clients without a Node HTTP server", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
      documentAppHtml: "<!doctype html><title>Tabula Document</title>",
    });
    const client = new Client({ name: "tabula-web-handler-test", version: "0.0.0" });
    const fetchImpl = (request: RequestInfo | URL, init?: RequestInit) => {
      const normalized = request instanceof Request ? request : new Request(request, init);
      return handler.fetch(normalized);
    };

    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
          fetch: fetchImpl,
        }),
      );
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "start_session",
        "join_room",
        "leave_session",
        "list_files",
        "read_file",
        "read_multiple_files",
        "search_files",
        "list_comments",
        "add_comment",
        "reply_to_comment",
        "resolve_comment",
        "delete_comment",
        "write_file",
        "write_files",
        "edit_file",
        "create_directory",
        "move_file",
        "delete_path",
        "import_copy",
        "export_copy",
      ]);
    } finally {
      await client.close();
    }
  });

  it("requires an auth token when production mode is enabled", () => {
    expect(() =>
      createTabulaMcpWebHandler({
        deploymentMode: "remote",
        production: true,
      }),
    ).toThrow(/TABULA_MCP_AUTH_TOKEN/);
  });

  it("allows explicit public unauthenticated hosted production without bearer headers", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
      documentAppHtml: "<!doctype html><title>Tabula Document</title>",
      env: {
        TABULA_MCP_AUTH_TOKEN: "stale-secret",
        TABULA_MCP_PUBLIC_UNAUTHENTICATED: "1",
      },
      production: true,
    });
    const health = await handler.fetch(new Request("https://mcp.example.com/health"));
    const client = new Client(
      { name: "tabula-public-web-handler-test", version: "0.0.0" },
      { capabilities: uiCapabilities },
    );
    const fetchImpl = (request: RequestInfo | URL, init?: RequestInit) =>
      handler.fetch(request instanceof Request ? request : new Request(request, init));
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
      fetch: fetchImpl,
    });

    try {
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        publicUnauthenticated: true,
        statelessHttp: false,
      });
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);

      expect(toolNames).toEqual([
        "start_session",
        "join_room",
        "leave_session",
        "list_files",
        "read_file",
        "read_multiple_files",
        "search_files",
        "list_comments",
        "add_comment",
        "reply_to_comment",
        "resolve_comment",
        "delete_comment",
        "write_file",
        "write_files",
        "edit_file",
        "create_directory",
        "move_file",
        "delete_path",
        "import_copy",
        "export_copy",
      ]);
      expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await client.close();
    }
  });

  it("rejects remote stateless HTTP because room and workspace tools require sessions", () => {
    expect(() =>
      createTabulaMcpWebHandler({
        deploymentMode: "remote",
        env: {
          TABULA_MCP_STATELESS_HTTP: "1",
        },
        production: true,
      }),
    ).toThrow(/require stateful MCP HTTP sessions/i);
  });

  it("rejects wildcard browser origins in production unless explicitly allowed", () => {
    expect(() =>
      createTabulaMcpWebHandler({
        authToken: "secret",
        deploymentMode: "remote",
        env: {
          TABULA_MCP_ALLOWED_ORIGINS: "*",
        },
        production: true,
      }),
    ).toThrow(/ALLOWED_ORIGINS=\*/i);
  });

  it("rejects unlisted browser origins in production and allows configured origins", async () => {
    const handler = createTabulaMcpWebHandler({
      authToken: "secret",
      deploymentMode: "remote",
      env: {
        TABULA_MCP_ALLOWED_ORIGINS: "https://tabula.md",
      },
      production: true,
    });

    const rejected = await handler.fetch(
      new Request("https://mcp.example.com/mcp", {
        headers: {
          authorization: "Bearer secret",
          origin: "https://evil.example",
        },
      }),
    );
    const accepted = await handler.fetch(
      new Request("https://mcp.example.com/mcp", {
        headers: {
          authorization: "Bearer secret",
          origin: "https://tabula.md",
        },
      }),
    );

    expect(rejected.status).toBe(403);
    expect(accepted.status).toBe(400);
    expect(accepted.headers.get("access-control-allow-origin")).toBe("https://tabula.md");
  });

  it("protects MCP requests with a bearer token when configured", async () => {
    const handler = createTabulaMcpWebHandler({
      authToken: "secret",
      deploymentMode: "remote",
    });

    const unauthorized = await handler.fetch(new Request("https://mcp.example.com/mcp"));
    expect(unauthorized.status).toBe(401);

    const authorized = await handler.fetch(
      new Request("https://mcp.example.com/mcp", {
        headers: {
          authorization: "Bearer secret",
        },
      }),
    );
    expect(authorized.status).toBe(400);
  });

  it("returns 404 for unknown stateful session ids", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
    });
    const response = await handler.fetch(
      new Request("https://mcp.example.com/mcp", {
        headers: {
          "mcp-session-id": "missing-session",
        },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        message: "Session not found.",
      },
    });
  });

  it("rate limits MCP requests per client identity", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
    });

    const first = await handler.fetch(new Request("https://mcp.example.com/mcp"));
    const second = await handler.fetch(new Request("https://mcp.example.com/mcp"));

    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
  });

  it("rejects oversized MCP request bodies before transport handling", async () => {
    const handler = createTabulaMcpWebHandler({
      deploymentMode: "remote",
      maxRequestBytes: 8,
    });
    const response = await handler.fetch(
      new Request("https://mcp.example.com/mcp", {
        body: JSON.stringify({ too: "large" }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(413);
  });

  it("exposes room and workspace tools from hosted production mode", async () => {
    const handler = createTabulaMcpWebHandler({
      authToken: "secret",
      deploymentMode: "remote",
      documentAppHtml: "<!doctype html><title>Tabula Document</title>",
      production: true,
    });
    const client = new Client({ name: "tabula-production-web-handler-test", version: "0.0.0" });
    const fetchImpl = (request: RequestInfo | URL, init?: RequestInit) =>
      handler.fetch(request instanceof Request ? request : new Request(request, init));
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
      fetch: fetchImpl,
      requestInit: {
        headers: {
          authorization: "Bearer secret",
        },
      },
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);

      expect(toolNames).toEqual([
        "start_session",
        "join_room",
        "leave_session",
        "list_files",
        "read_file",
        "read_multiple_files",
        "search_files",
        "list_comments",
        "add_comment",
        "reply_to_comment",
        "resolve_comment",
        "delete_comment",
        "write_file",
        "write_files",
        "edit_file",
        "create_directory",
        "move_file",
        "delete_path",
        "import_copy",
        "export_copy",
      ]);
      expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await client.close();
    }
  });
});
