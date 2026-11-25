# postman

Guides a ContinuumDAO MPA Wallet node through the Postman MCP server. Version **0.1.0**. This package is not a signed catalog release yet.

The plugin is a skill and a slash prompt. It does not ship an entrypoint, and it does not store an API key. Postman tools come from the repository MCP server `postman`.

Local notes and exports stay in `user_folder/data/postman`. The skill tells the agent not to open any other path in the user folder. That is an instruction to the model. The host does not jail the chat to that directory, and it does not limit what the Postman MCP server can do in the Postman account.

## Run

From the node chat, after that MCP server is active and Variable `POSTMAN_API_KEY` is set:

```text
/postman list my workspaces
```

The prompt loads the `postman` skill. The skill loads MCP server `postman` when its tools are not already in the chat, then calls `getAuthenticatedUser` before other work. A change to a workspace, collection, spec, mock, monitor, or flow happens only when the message asks for that change.

## Node setup

Activate **Postman** from the MCP repository catalog. The catalog row is HTTP `https://mcp.postman.com/mcp` with `apiKeyEnvVar` `POSTMAN_API_KEY`. Set that Variable in **AI Agent → Variables**. The value is a Postman API key (`PMAK-…`) with no `Bearer ` prefix. The agent sees the name, not the value.

The plugin permission is `user_folder:read`. It does not request network. The MCP server holds the network connection.
