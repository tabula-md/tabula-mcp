const params = new URLSearchParams(window.location.search);
if (!params.has("tabula-dev")) {
  params.set("tabula-dev", "1");
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

const { createDevApp } = await import("./mock-app.js");
window.__TABULA_CREATE_APP__ = createDevApp;

await import("../app/document-app.js");
