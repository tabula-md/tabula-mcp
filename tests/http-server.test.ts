import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../src/documents/store.js";
import { createTabulaMcpHttpServer, resolveHttpServerOptions } from "../src/server/http.js";

const serverUrl = (address: string, port: number, path = "") => `http://${address}:${port}${path}`;

describe("Tabula MCP HTTP server", () => {
  it("binds local HTTP servers to localhost by default", () => {
    expect(resolveHttpServerOptions({}, {} as NodeJS.ProcessEnv).host).toBe("127.0.0.1");
  });

  it("serves health metadata with remote checkpoint store details", async () => {
    const httpServer = createTabulaMcpHttpServer({
      deploymentMode: "remote",
      documentStore: new MemoryDocumentStore(),
      host: "127.0.0.1",
      port: 0,
      writeEnabled: true,
    });

    try {
      await httpServer.listen();
      const address = httpServer.server.address() as AddressInfo;
      const response = await fetch(serverUrl(address.address, address.port, "/health"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: "tabula-mcp",
        version: "0.5.0",
        writeAccess: "enabled",
        deploymentMode: "remote",
        documentStore: "memory",
      });
      expect(httpServer.version).toBe("0.5.0");
      expect(httpServer.writeAccess).toBe("enabled");
    } finally {
      await httpServer.close();
    }
  });

  it("describes the hosted product at the service root", async () => {
    const httpServer = createTabulaMcpHttpServer({
      deploymentMode: "remote",
      documentStore: new MemoryDocumentStore(),
      host: "127.0.0.1",
      port: 0,
    });

    try {
      await httpServer.listen();
      const address = httpServer.server.address() as AddressInfo;
      const response = await fetch(serverUrl(address.address, address.port, "/"));

      await expect(response.json()).resolves.toMatchObject({
        description: "Connect Codex, Claude, and other MCP clients to shared Tabula workspaces.",
      });
    } finally {
      await httpServer.close();
    }
  });

  it("serves readiness metadata after checking the checkpoint store", async () => {
    let checked = false;
    const documentStore = new MemoryDocumentStore();
    documentStore.checkReady = () => {
      checked = true;
    };
    const httpServer = createTabulaMcpHttpServer({
      deploymentMode: "remote",
      documentStore,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      await httpServer.listen();
      const address = httpServer.server.address() as AddressInfo;
      const response = await fetch(serverUrl(address.address, address.port, "/ready"));

      expect(response.status).toBe(200);
      expect(checked).toBe(true);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: "tabula-mcp",
        version: "0.5.0",
        writeAccess: "enabled",
        deploymentMode: "remote",
        documentStore: "memory",
      });
    } finally {
      await httpServer.close();
    }
  });

  it("accepts Streamable HTTP MCP clients on /mcp", async () => {
    const httpServer = createTabulaMcpHttpServer({
      deploymentMode: "remote",
      documentStore: new MemoryDocumentStore(),
      host: "127.0.0.1",
      port: 0,
    });
    const client = new Client({ name: "tabula-http-test", version: "0.0.0" });

    try {
      await httpServer.listen();
      const address = httpServer.server.address() as AddressInfo;
      await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl(address.address, address.port, "/mcp"))));
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
      await Promise.allSettled([client.close(), httpServer.close()]);
    }
  });

  it("protects MCP requests with a bearer token when configured", async () => {
    const httpServer = createTabulaMcpHttpServer({
      authToken: "secret",
      deploymentMode: "remote",
      documentStore: new MemoryDocumentStore(),
      host: "127.0.0.1",
      port: 0,
    });

    try {
      await httpServer.listen();
      const address = httpServer.server.address() as AddressInfo;
      const unauthorized = await fetch(serverUrl(address.address, address.port, "/mcp"));
      const authorized = await fetch(serverUrl(address.address, address.port, "/mcp"), {
        headers: {
          authorization: "Bearer secret",
        },
      });

      expect(unauthorized.status).toBe(401);
      expect(authorized.status).toBe(400);
    } finally {
      await httpServer.close();
    }
  });

  it("returns 404 for unknown stateful session ids", async () => {
    const httpServer = createTabulaMcpHttpServer({
      deploymentMode: "remote",
      documentStore: new MemoryDocumentStore(),
      host: "127.0.0.1",
      port: 0,
    });

    try {
      await httpServer.listen();
      const address = httpServer.server.address() as AddressInfo;
      const response = await fetch(serverUrl(address.address, address.port, "/mcp"), {
        headers: {
          "mcp-session-id": "missing-session",
        },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: -32001,
          message: "Session not found.",
        },
      });
    } finally {
      await httpServer.close();
    }
  });
});
