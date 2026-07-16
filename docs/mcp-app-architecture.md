# MCP App architecture

Tabula's MCP App is a compact handoff card, not an embedded Markdown editor.

The same nine core tools are registered for MCP Apps and non-App clients. Four handoff tools include the App resource URI:

- `tabula_create_draft`
- `tabula_update_draft`
- `tabula_start_session`
- `tabula_join_room`

The card renders only the compact success result. Its buttons call the same public services used by the model:

```text
Open a copy / Export copy
→ tabula_export_copy
→ exportCopy()
→ official @tabula-md/tabula snapshot serializer
```

```text
Start session
→ tabula_start_session
→ startDraftSession()
```

The App opens external `#json` and `#room` links through the MCP host's `openLink` API. It does not duplicate Tabula's editor or collaboration UI.

The App resource URI contains a content fingerprint so hosts do not reuse stale bundled UI after an upgrade.
