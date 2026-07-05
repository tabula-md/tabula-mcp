import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const expectedExports = [
  {
    specifier: ".",
    declaration: "dist/index.d.ts",
    values: [
      "createTabulaMcpServer",
      "createTabulaMcpHttpServer",
      "createTabulaMcpWebHandler",
      "resolveWriteEnabled",
    ],
  },
  {
    specifier: "./server",
    declaration: "dist/server/index.d.ts",
    values: [
      "createTabulaMcpServer",
      "createTabulaMcpHttpServer",
      "createTabulaMcpWebHandler",
      "resolveWriteEnabled",
    ],
  },
  {
    specifier: "./protocol",
    declaration: "dist/protocol.d.ts",
    values: ["parseRoomShareUrl", "resolveRoomServerUrl"],
  },
  {
    specifier: "./documents",
    declaration: "dist/documents/index.d.ts",
    values: ["DocumentRegistry", "MemoryDocumentStore", "FileDocumentStore", "UpstashRedisDocumentStore"],
  },
];

const main = async () => {
  for (const expectedExport of expectedExports) {
    if (!existsSync(path.join(rootDir, expectedExport.declaration))) {
      throw new Error(`Package export ${expectedExport.specifier} is missing ${expectedExport.declaration}`);
    }

    const importSpecifier =
      expectedExport.specifier === "." ? "@tabula-md/mcp" : `@tabula-md/mcp${expectedExport.specifier.slice(1)}`;
    const mod = await import(importSpecifier);
    for (const value of expectedExport.values) {
      if (!(value in mod)) {
        throw new Error(`Package export ${expectedExport.specifier} is missing ${value}`);
      }
    }
  }

  console.log("Package exports check passed");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
