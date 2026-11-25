# Plugins for ContinuumDAO Multi-Party Agent Wallet

This repository holds plugins for a ContinuumDAO Multi-Party Agent (MPA) Wallet node. Each plugin is one directory. Later plugins are added as sibling directories. They are not published to the node catalog from this repository until a node with veCTM signs a release.

## Layout

```text
<plugin-name>/
  mpa-plugin.json
  extension/index.js
  skills/<plugin-name>/SKILL.md
  prompts/<plugin-name>.md
  README.md
```

`mpa-plugin.json` names the skill, the slash prompt, the entrypoint, the permissions, and the Variables the node fills in. The entrypoint never receives those Variable values.

## Plugins

| Directory | What it does |
|---|---|
| [`trade-bot-macd-uniswap`](trade-bot-macd-uniswap/) | MACD 12/26/9 pullback entries on Uniswap V4, bought and sold with USDC. v1.0.0. |
| [`postman`](postman/) | Skill and slash prompt for the catalog Postman MCP server. Local files stay under `data/postman`. Draft 0.1.0, not yet published. |
| [`kairos-fixed-rate-borrow`](kairos-fixed-rate-borrow/) | Kairos fixed-rate USDC and USDT borrows on Aave V3 Ethereum. Quotes fees and the early-exit penalty, then opens, locks, repays, or closes. Draft 0.1.0, not yet published. |
| [`trade-bot-hyperliquid-perp`](trade-bot-hyperliquid-perp/) | Hyperliquid perpetual decision from a market name and one technical-analysis type. Optional momentum and candlestick confirmation. Draft 0.1.0, not yet published. |

## Install on a node

Copy a plugin directory to `user_folder/plugins/<plugin-name>/` on the node. In the node UI, open **AI Plugins**, review the permission card, and approve it before the entrypoint can run. The chat command is `/<plugin-name>`.

Leave `.trust.json`, `.mpa-state.json`, and `.position-state.json` on the node. Those files are local approval and position state, not part of the plugin source.
