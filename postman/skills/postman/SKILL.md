---
name: postman
description: Use the catalog MCP server postman to inspect or change Postman workspaces, collections, specs, mocks, monitors, and flows. Load when the operator asks to work in Postman.
---

# Postman

The tools come from the catalog MCP server `postman`. Load it with `agent_load_mcp_server` when those tools are not already in this chat. This plugin does not call Postman itself and has no entrypoint.

The server reads Variable `POSTMAN_API_KEY`. The value stays in Variables. Do not ask for it and do not pass it as a tool argument.

1. Call `getAuthenticatedUser`. If that fails, say the Variable is missing or was rejected, and stop.
2. Use only tools the connected server actually exposed. Do not invent tool names. Prefer the smallest set that covers the request.
3. Search for a resource, then fetch the full object, before changing it. A search preview is not enough to replace a collection or to say an API is absent.
4. Report the resource and the tool result. A successful tool call does not by itself mean a mock is public or a monitor run passed.

Do not run a shell.
