const isNodeRuntime = typeof process === "object" && Boolean(process.versions?.node);

if (isNodeRuntime) {
  // Node 26 exposes experimental Web Storage globals that warn on access when
  // no persistence file is configured. Tabula does not persist MCP state in
  // those globals, so leave them absent and let lib0 use its memory fallback.
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "sessionStorage");
}
