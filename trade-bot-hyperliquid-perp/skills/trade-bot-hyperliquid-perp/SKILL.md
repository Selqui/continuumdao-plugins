---
name: trade-bot-hyperliquid-perp
description: Decide a Hyperliquid perpetual from a market name and one technical-analysis type. Load before a dry-run, a backtest, or a live decision. A contract address is rejected.
---

# trade-bot-hyperliquid-perp

One tool, `perp_trade_decision`. **This plugin never signs and never posts a multi-sign request.** An open or a close returns an unsigned payload. The agent opens the sign request.

Candlestick analysis, and every other accepted type, runs inside this plugin through the market-data library. That includes `analysisType` `candlestick_patterns` and the `candlestick` switch. Call only `perp_trade_decision` for this decision. Do not call `analyze_candlestick_patterns` or any other `analyze_*` chart tool in the same turn, and do not draw a candlestick menu from this result. The plugin returns the decision or the backtest numbers. It does not return a chart highlight.

Interactive chart analysis stays available. A later message that asks for a chart, or that names an `analyze_` tool, uses those chart tools as usual.

## Arguments

- `asset` is the Hyperliquid market name, such as `BTC`. A `0x` contract address is an error. The name does not have to be a saved token on this node.
- `interval` and `candleCount` select the Hyperliquid candles. `lookbackDays` is optional.
- `analysisType` is one of these library ids, written with underscores: `trend_structure`, `elliott_waves`, `key_levels`, `key_level_fibonacci`, `divergence`, `range_volatility`, `bollinger_bands`, `donchian_breakout`, `supertrend`, `ichimoku`, `z_score`, `moving_averages`, `chart_patterns`, `momentum`, `candlestick_patterns`. Liquidity depth and the time-series analyses are not accepted, because they do not produce a Trade Idea.
- `analysisSettings` is the periods and entry settings for that type. Read them from Host YAML `trade-desk.yaml` on the Skills catalogue and pass them in. Editing that file changes later runs. The plugin does not read the file.
- `mode` is `dry-run`, `backtest`, or `live`. Only `live` reads the KeyGen spot USDC balance and the open perpetual.
- `momentum` and `candlestick` are optional switches. Both default off. When `momentum` is on, a long or a short is allowed only when the momentum Trade Idea is that same side and clear (RSI oversold with a bullish MACD cross, or RSI overbought with a bearish MACD cross). When `candlestick` is on, the candlestick Trade Idea must be that same side and clear, buy for a long and sell for a short. If a switch that is on does not confirm, the result is do nothing, including no close. If the primary type is already momentum or candlestick, that idea is its own confirmation.
- `percent` sizes a live open as a percentage of spot USDC. The default is 50. A live open is refused when that amount is larger than the spot USDC balance.

## Decision

| Situation | Result |
|---|---|
| No open perpetual, and a clear idea, and every switch that is on confirms | unsigned payload that opens |
| Open perpetual already in that direction | do nothing |
| Open perpetual in the opposite direction, and every switch that is on confirms | unsigned payload that closes |
| No clear idea, or a switch that is on does not confirm | do nothing |

Dry-run treats the book as flat and does not read a balance. Backtest replays the same rules over the fetched candles and returns a balance series, the final balance, and the percent P&L. It does not use real USDC.
