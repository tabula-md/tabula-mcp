import assert from "node:assert/strict";

assert(process.env.CLOUDFLARE_API_TOKEN?.trim(), "CLOUDFLARE_API_TOKEN is required before publishing a release.");
assert(process.env.CLOUDFLARE_ACCOUNT_ID?.trim(), "CLOUDFLARE_ACCOUNT_ID is required before publishing a release.");
console.log("Production deployment credentials are configured");
