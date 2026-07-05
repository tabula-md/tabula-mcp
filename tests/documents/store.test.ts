import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileDocumentStore,
  MemoryDocumentStore,
  UpstashRedisDocumentStore,
  createDefaultDocumentStore,
  resolveDefaultDocumentStoreDirectory,
} from "../../src/documents/store.js";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tabula-mcp-store-"));
  tempDirs.push(directory);
  return directory;
};

const storedDocument = (documentId: string, markdown: string, updatedAt = "2026-01-01T00:00:00.000Z") => ({
  documentId,
  title: "Draft",
  markdown,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FileDocumentStore", () => {
  it("persists documents and the latest document id across store instances", () => {
    const directory = createTempDir();
    const document = storedDocument("11111111-1111-4111-8111-111111111111", "# Draft\n\nBody");

    const firstStore = new FileDocumentStore({ directory });
    firstStore.set(document);

    const secondStore = new FileDocumentStore({ directory });

    expect(secondStore.latestDocumentId()).toBe(document.documentId);
    expect(secondStore.get(document.documentId)).toEqual(document);
  });

  it("prunes older checkpoints by updatedAt", () => {
    const directory = createTempDir();
    const store = new FileDocumentStore({ directory, maxDocuments: 2 });

    store.set(storedDocument("11111111-1111-4111-8111-111111111111", "one", "2026-01-01T00:00:00.000Z"));
    store.set(storedDocument("22222222-2222-4222-8222-222222222222", "two", "2026-01-02T00:00:00.000Z"));
    store.set(storedDocument("33333333-3333-4333-8333-333333333333", "three", "2026-01-03T00:00:00.000Z"));

    const restoredStore = new FileDocumentStore({ directory, maxDocuments: 2 });

    expect(restoredStore.get("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(restoredStore.get("22222222-2222-4222-8222-222222222222")?.markdown).toBe("two");
    expect(restoredStore.get("33333333-3333-4333-8333-333333333333")?.markdown).toBe("three");
  });

  it("ignores corrupted checkpoint files and starts empty", () => {
    const directory = createTempDir();
    const store = new FileDocumentStore({ directory });
    store.set(storedDocument("11111111-1111-4111-8111-111111111111", "valid"));
    writeFileSync(path.join(directory, "documents-v1.json"), "{not-json", "utf8");

    const emptyStore = new FileDocumentStore({ directory });

    expect(emptyStore.latestDocumentId()).toBeNull();
  });
});

describe("MemoryDocumentStore", () => {
  it("expires remote-style checkpoints when a TTL is configured", async () => {
    let now = 1_000;
    const store = new MemoryDocumentStore({ ttlMs: 1_000, now: () => now });
    const document = storedDocument("11111111-1111-4111-8111-111111111111", "ephemeral");

    await store.set(document);
    expect(await store.get(document.documentId)).toEqual(document);

    now = 2_001;
    expect(await store.get(document.documentId)).toBeNull();
    expect(await store.latestDocumentId()).toBeNull();
  });
});

describe("UpstashRedisDocumentStore", () => {
  it("stores remote MCP checkpoints through the Upstash REST command API", async () => {
    const values = new Map<string, string>();
    const sortedSets = new Map<string, Map<string, number>>();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const commandOrPipeline = JSON.parse(String(init?.body)) as unknown[];
      const runCommand = (command: unknown[]) => {
        const [rawCommand, ...args] = command;
        const redisCommand = String(rawCommand).toUpperCase();
        if (redisCommand === "SET") {
          values.set(String(args[0]), String(args[1]));
          return { result: "OK" };
        }
        if (redisCommand === "GET") {
          return { result: values.get(String(args[0])) ?? null };
        }
        if (redisCommand === "PING") {
          return { result: "PONG" };
        }
        if (redisCommand === "ZADD") {
          const key = String(args[0]);
          const set = sortedSets.get(key) ?? new Map<string, number>();
          set.set(String(args[2]), Number(args[1]));
          sortedSets.set(key, set);
          return { result: 1 };
        }
        if (redisCommand === "ZREVRANGE") {
          const key = String(args[0]);
          const start = Number(args[1]);
          const end = Number(args[2]);
          const sorted = [...(sortedSets.get(key)?.entries() ?? [])]
            .sort((left, right) => right[1] - left[1])
            .map(([member]) => member);
          return { result: sorted.slice(start, end < 0 ? undefined : end + 1) };
        }
        if (redisCommand === "EXPIRE" || redisCommand === "ZREMRANGEBYRANK") {
          return { result: 1 };
        }
        if (redisCommand === "DEL") {
          for (const key of args) {
            values.delete(String(key));
            sortedSets.delete(String(key));
          }
          return { result: args.length };
        }
        return { error: `Unhandled command: ${redisCommand}` };
      };

      const result = String(url).endsWith("/pipeline")
        ? (commandOrPipeline as unknown[][]).map(runCommand)
        : runCommand(commandOrPipeline);
      return new Response(JSON.stringify(result), { status: 200 });
    });
    const store = new UpstashRedisDocumentStore({
      restUrl: "https://redis.example.com",
      token: "token",
      fetchImpl: fetchMock as typeof fetch,
      keyPrefix: "test:documents",
    });
    const document = storedDocument("11111111-1111-4111-8111-111111111111", "# Remote");

    await store.set(document);

    expect(await store.latestDocumentId()).toBe(document.documentId);
    expect(await store.get(document.documentId)).toEqual(document);
    expect(await store.list()).toEqual([document]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://redis.example.com/pipeline",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
    await expect(store.checkReady()).resolves.toBeUndefined();
  });
});

describe("default document store", () => {
  it("uses a configured checkpoint directory when provided", () => {
    const directory = createTempDir();
    const store = createDefaultDocumentStore({
      env: {
        TABULA_MCP_DOCUMENT_STORE_DIR: directory,
      },
    });
    const document = storedDocument("11111111-1111-4111-8111-111111111111", "checkpoint");

    store.set(document);

    expect(new FileDocumentStore({ directory }).get(document.documentId)).toEqual(document);
  });

  it("can disable file checkpoints for memory-only sessions", () => {
    const store = createDefaultDocumentStore({
      env: {
        TABULA_MCP_DISABLE_DOCUMENT_CHECKPOINTS: "1",
      },
    });

    expect(store).toBeInstanceOf(MemoryDocumentStore);
  });

  it("uses a TTL memory checkpoint store by default in remote deployment mode", () => {
    const store = createDefaultDocumentStore({
      deploymentMode: "remote",
      env: {},
    });

    expect(store).toBeInstanceOf(MemoryDocumentStore);
    expect(store.kind).toBe("memory");
  });

  it("uses Upstash Redis in remote deployment mode when REST credentials are configured", () => {
    const store = createDefaultDocumentStore({
      deploymentMode: "remote",
      env: {
        UPSTASH_REDIS_REST_URL: "https://redis.example.com",
        UPSTASH_REDIS_REST_TOKEN: "token",
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(store).toBeInstanceOf(UpstashRedisDocumentStore);
    expect(store.kind).toBe("upstash-redis");
  });

  it("requires Redis credentials for production remote deployment mode", () => {
    expect(() =>
      createDefaultDocumentStore({
        deploymentMode: "remote",
        env: {},
        production: true,
      }),
    ).toThrow(/requires .*REST token/i);

    expect(() =>
      createDefaultDocumentStore({
        deploymentMode: "remote",
        env: {
          TABULA_MCP_DOCUMENT_STORE_DRIVER: "memory",
        },
        production: true,
      }),
    ).toThrow(/requires Redis/i);

    expect(() =>
      createDefaultDocumentStore({
        deploymentMode: "remote",
        env: {
          TABULA_MCP_ALLOW_MEMORY_STORE: "1",
        },
        production: true,
      }),
    ).toThrow(/DOCUMENT_STORE_DRIVER=memory/i);
  });

  it("allows explicit unsafe production memory checkpoints for Excalidraw-style self-hosting", () => {
    const store = createDefaultDocumentStore({
      deploymentMode: "remote",
      env: {
        TABULA_MCP_ALLOW_MEMORY_STORE: "1",
        TABULA_MCP_DOCUMENT_STORE_DRIVER: "memory",
      },
      production: true,
    });

    expect(store).toBeInstanceOf(MemoryDocumentStore);
    expect(store.kind).toBe("memory");
  });

  it("resolves stable platform-specific default directories", () => {
    expect(
      resolveDefaultDocumentStoreDirectory({
        env: {},
        platform: "darwin",
        homedir: "/Users/taeha",
      }),
    ).toBe("/Users/taeha/Library/Application Support/Tabula.md MCP/documents");
    expect(
      resolveDefaultDocumentStoreDirectory({
        env: { LOCALAPPDATA: "C:\\Users\\taeha\\AppData\\Local" },
        platform: "win32",
        homedir: "C:\\Users\\taeha",
      }),
    ).toContain("Tabula.md MCP");
    expect(
      resolveDefaultDocumentStoreDirectory({
        env: { XDG_STATE_HOME: "/home/taeha/.local/state" },
        platform: "linux",
        homedir: "/home/taeha",
      }),
    ).toBe("/home/taeha/.local/state/tabula-mcp/documents");
  });
});
