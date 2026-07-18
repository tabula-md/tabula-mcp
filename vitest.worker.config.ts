import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const quotaHashSecret = "workerd-session-isolation-secret";

export default defineConfig({
  assetsInclude: ["**/*.html"],
  plugins: [
    cloudflareTest({
      main: "./workers/tabula-mcp-worker.ts",
      miniflare: {
        bindings: {
          TABULA_MCP_ALLOW_MEMORY_STORE: "1",
          TABULA_MCP_DEPLOYMENT_MODE: "remote",
          TABULA_MCP_DOCUMENT_STORE_DRIVER: "memory",
          TABULA_MCP_LOG_LEVEL: "silent",
          TABULA_MCP_MAX_SESSIONS_PER_CLIENT: "2",
          TABULA_MCP_PRODUCTION: "0",
          TABULA_MCP_PUBLIC_UNAUTHENTICATED: "0",
          TABULA_MCP_QUOTA_HASH_SECRET: quotaHashSecret,
          TABULA_MCP_RATE_LIMIT_MAX: "100",
          TABULA_MCP_SESSION_IDLE_TTL_MS: "60000",
        },
        compatibilityDate: "2026-07-05",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          TABULA_MCP_QUOTA: "TabulaMcpQuotaDurableObject",
          TABULA_MCP_SESSIONS: "TabulaMcpSessionDurableObject",
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
  },
});
