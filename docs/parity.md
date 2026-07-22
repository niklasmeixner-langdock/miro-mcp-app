# Miro MCP compatibility

This server preserves the 31 tool names documented by Miro on July 16, 2026.
It only calls public Miro APIs. Miro does not publish the official server's
complete JSON schemas, so the schemas in this repository are a compatible,
independent contract rather than a claim of byte-for-byte equivalence.

## Native public API tools

| Group | Tools |
|---|---|
| Boards | `board_create`, `board_search_boards`, `board_list_items` |
| Discovery | `context_explore` |
| Layout | `layout_get_dsl`, `layout_read`, `layout_create`, `layout_update` |
| Diagram | `diagram_get_dsl`, `diagram_create` |
| Images | `image_create`, `image_get_data`, `image_get_upload_url`, `image_get_url` |
| Code | `code_widget_create`, `code_widget_get`, `code_widget_list_items`, `code_widget_update`, `code_widget_delete` |

`context_get` uses public item reads and returns deterministic text for the host
model to summarize. It does not consume Miro AI credits.

## App-managed emulation

| Group | Tools | Representation |
|---|---|---|
| Documents | `doc_create`, `doc_get`, `doc_update` | Miro text item plus app metadata |
| Tables | `table_create`, `table_list_rows`, `table_sync_rows` | Visual text table plus typed app metadata |
| Prototypes | `prototype_create`, `prototype_read` | Screen frames plus retained HTML metadata |

Only artifacts created by this app can be updated through these tools. The
current artifact store is process-local; replace `ArtifactStore` with a durable
adapter before running multiple replicas.

## Publicly unavailable

`comment_list_comments`, `comment_reply`, and `comment_resolve` return a
structured `CAPABILITY_UNAVAILABLE` result. Miro does not expose comment thread
operations through its public REST API. No private endpoint is used.

## Additional protocol capabilities

- Streamable HTTP at `/mcp`
- OAuth 2.1 discovery, dynamic client registration, PKCE S256, refresh tokens,
  resource indicators, and Miro OAuth brokering
- `code_explain_on_board` and `code_create_from_board` prompts
- One additional `render_miro_board` tool backed by the interactive
  `ui://miro/workspace` resource. Parity tools never open separate UI cards;
  it uses Miro's official `/api/v1/oembed` response to display one full-size
  native Live Embed iframe.

Exact official schema parity requires an authorized capture of `initialize`,
`tools/list`, `prompts/list`, and representative results from
`https://mcp.miro.com/`.
