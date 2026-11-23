---
description: Hyperliquid perpetual decision from a market name and one analysis type
argument-hint: <market> <interval> <candles> <analysisType> [dry-run|backtest|live] [momentum] [candlestick] [percent]
---

Load the `trade-bot-hyperliquid-perp` skill, then call `perp_trade_decision` once.

The plugin runs candlestick analysis and the other analysis types in its own library call. Do not call `analyze_candlestick_patterns` or any other `analyze_*` chart tool in this turn. Do not draw a chart from this result. A later message that asks for a chart still uses the interactive analysis tools.

- Market name: ${1:-}
- Candle interval: ${2:-4h}
- Number of candles: ${3:-200}
- Analysis type id: ${4:-}
- Remainder: ${@:5}

The market name is a Hyperliquid name such as `BTC`. If it is empty, stop and ask. If it is a contract address, stop and ask for the market name. Do not call `get_token_registry`. The name does not have to be a saved asset.

The analysis type must be one of the fifteen ids in the skill. If it is empty, stop and ask which id to use. Do not offer liquidity depth or a time-series analysis.

Before the call, read Host YAML `trade-desk.yaml` and pass that type's periods and entry settings as `analysisSettings`. Do not invent those numbers. Tell the user that editing `trade-desk.yaml` on the Skills catalogue changes later runs.

Read the remainder from the left.

- A number, or a number with `%`, is `percent`. Otherwise `percent` is 50.
- `backtest`, `dry-run`, and `live` choose `mode`. If none is present, use `dry-run`.
- The words `momentum` and `candlestick` turn those switches on. Leave them off when the words are absent.

Only `live` may be followed by a multi-sign request, and only when the tool returns an unsigned open or close payload. Dry-run and backtest do not use real USDC. A result of do nothing is finished. Do not invent an order for it.
