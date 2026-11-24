---
name: trade-bot-hyperliquid-perp
description: Decide a Hyperliquid perpetual from a market name and one technical-analysis type. Load before a dry-run, a backtest, or a live decision. A contract address is rejected.
---

# trade-bot-hyperliquid-perp

One tool, `perp_trade_decision`. **This plugin never signs and never posts a multi-sign request.** An open or a close returns an unsigned payload. The agent opens the sign request.

Candlestick analysis, and every other accepted type, runs inside this plugin through the market-data library. That includes `analysisType` `candlestick_patterns` and the `candlestick` switch. Call only `perp_trade_decision` for this decision. Do not call `analyze_candlestick_patterns` or any other `analyze_*` chart tool in the same turn, and do not draw a candlestick menu from this result. The plugin returns the decision or the backtest numbers. A backtest includes `ledger`: one row per closed trade, plus a final row when a position is still open. Each row has `side`, `entryPrice`, `exitPrice`, `entryTimeMs`, `exitTimeMs`, `qty`, `margin`, `pnl`, `balanceUsdc`, and `reason` (`invalidation`, `target`, `liquidation`, or `signal`). Report that ledger with the balance. It does not return a chart highlight.

Interactive chart analysis stays available. A later message that asks for a chart, or that names an `analyze_` tool, uses those chart tools as usual.

## Arguments

- `asset` is the Hyperliquid market name, such as `BTC`. A `0x` contract address is an error. The name does not have to be a saved token on this node.
- `interval` and `candleCount` select the Hyperliquid candles. `lookbackDays` is optional.
- `analysisType` is one of these library ids, written with underscores: `trend_structure`, `elliott_waves`, `key_levels`, `key_level_fibonacci`, `divergence`, `range_volatility`, `bollinger_bands`, `donchian_breakout`, `supertrend`, `ichimoku`, `z_score`, `moving_averages`, `chart_patterns`, `momentum`, `candlestick_patterns`. Liquidity depth and the time-series analyses are not accepted, because they do not produce a Trade Idea.
- `analysisSettings` is the periods and entry settings for that type. Read the setting lines from `/app/agent_llm_config/trade-desk.yaml` with one command: `grep -E '^[ \t]*[A-Za-z][A-Za-z0-9]*:' /app/agent_llm_config/trade-desk.yaml`. Pass the `universal` lines and the `protocols.hyperliquid` lines. Do not cat the file, do not page an offload, and do not glob for it. The comments are for the editor, and `agent_read_file` cannot open that path. Omit a key the grep does not print. Do not invent numbers. Editing that file changes later runs. The plugin does not read the file.
- `mode` is `dry-run`, `backtest`, or `live`. Only `live` reads the KeyGen spot USDC balance and the open perpetual.
- `momentum` and `candlestick` are optional switches. Both default off. When `momentum` is on, an open requires the momentum Trade Idea on that same side and clear (RSI oversold with a bullish MACD cross, or RSI overbought with a bearish MACD cross). When `candlestick` is on, an open requires the candlestick Trade Idea on that same side and clear, buy for a long and sell for a short. A close does not use either switch. If the primary type is already momentum or candlestick, that idea is its own confirmation.
- `percent` is the fraction of the notional Hyperliquid will allow. The default is 50. Opening margin is notional divided by leverage, and collateral left over must cover 10% of that notional, so the maximum notional is `account * leverage / (1 + 0.1 * leverage)`. `percent` takes that fraction. Live uses the KeyGen perp account value. Dry-run and backtest use the paper balance.

## Decision

| Situation | Result |
|---|---|
| No open perpetual, and a clear idea, and momentum confirms when it is on, and candlestick confirms when it is on | unsigned payload that opens |
| Open perpetual already in that direction | do nothing |
| Open perpetual in the opposite direction | unsigned payload that closes |
| No clear idea, or momentum or candlestick is on and does not confirm an open | do nothing |

Dry-run treats the book as flat and does not read a balance. Every mode reads the KeyGen's current Hyperliquid leverage for that market once, at the start, and sizes an open with the collateral rule above. A paper open fills at the Trade Idea entry price only on a candle whose low and high contain that price. The entry can be on the signal candle or a later one while the idea is still an open. A later backtest bar that trades through the idea's invalidation, its target, or the liquidation price closes the paper position at that price. The book is then flat, so a clear idea can open again, including on that same bar. Dry-run and backtest do not use real USDC, and a backtest close does not sign or post a wallet transaction.
