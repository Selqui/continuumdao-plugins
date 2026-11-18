# postman

Guides a ContinuumDAO MPA Wallet node through the Postman MCP server. Version **0.1.0**. This package is not a signed catalog release yet.

The plugin is a skill and a slash prompt. It does not ship an entrypoint, and it does not store an API key. Postman tools come from the repository MCP server `postman`.

## Run

From the node chat, after that MCP server is active and Variable `POSTMAN_API_KEY` is set:

```text
/postman list my workspaces
```

The prompt loads the `postman` skill. The skill loads MCP server `postman` when its tools are not already in the chat, then calls `getAuthenticatedUser` before other work.

## Node setup

Activate **Postman** from the MCP repository catalog. The catalog row is HTTP `https://mcp.postman.com/mcp` with `apiKeyEnvVar` `POSTMAN_API_KEY`. Set that Variable in **AI Agent → Variables**. The value is a Postman API key (`PMAK-…`) with no `Bearer ` prefix. The agent sees the name, not the value.

The plugin permission is `user_folder:read`. It does not request network. The MCP server holds the network connection.
