---
description: MACD 12/26/9 pullback entry on Uniswap V4
argument-hint: <token> <chainId> <interval> <candles> [percent] [dry-run|live] [backtest]
---

Load the `trade-bot-macd-uniswap` skill, then run it with these arguments.

- Token name: ${1:-}
- chainId: ${2:-}
- Candle interval: ${3:-4h}
- Number of candles: ${4:-200}
- Remainder: ${@:5}

If the token name or chainId is empty, stop and ask for both. Do not guess either one.

1. Resolve the token name with `continuum__get_token_registry` (`symbol`, and `chain_id` from the chainId argument). Use `contract.contractAddress` as `tokenAddress` and `contract.decimals` as `tokenDecimals`. Do not guess an address. If the registry has no row, stop.

2. Read the remainder from the left.
   - If the first token is a number, or a number with a trailing `%`, that is `percentOfBalance`. Strip the `%`. Otherwise `percentOfBalance` is **50**.
   - The remaining words are flags, in either order, matched case-insensitively.
   - `backtest` — call `macd_backtest`.
   - `dry-run` — call `macd_entry_order` with `dryRun: true`.
   - `live` — call `macd_entry_order` with `dryRun: false`, then hand the returned `unsignedPayload` to the multi-sign request flow.
   - If no flag is present, run the backtest and a dry-run entry. Do not treat that as a live order.

3. Pass `chainId`, `tokenAddress`, `tokenDecimals`, `symbol`, `interval`, `candleCount`, and `percentOfBalance` to every backtest and entry call. Do not pass `lookbackDays` unless the operator also named a day count. Do not call a chart OHLCV tool. On an entry call, get the wallet balance with `agent_get_balance` and pass it as `balanceHuman`. The order size is `percentOfBalance` percent of that balance.

4. For a backtest, show one table with the columns **Metric**, **Value**, and **What it means**. Use these definitions, and do not rename them:

   | Metric | What it means |
   |---|---|
   | `pctProfit` | Change in the simulated USDC balance. Positive means the USDC balance ended higher than it started. |
   | `finalBalanceRatioPct` | Ending USDC balance as a percentage of the starting USDC. 100 means the balance was unchanged. |
   | `buyAndHoldPct` | Change in USDC value of the tokens that the starting USDC would have bought at the first MACD bar and held to the last bar. Positive means that USDC value increased. |
   | `maxDrawdownPct` | Largest peak-to-trough drop in the simulated USDC equity during the run. |
   | `feeTotalUsdc` | USDC paid as the simulated swap fee across every fill. |
   | `tradeCount` | Number of simulated fills. Each buy and each sell counts as one. |
   | `firstCloseUsdc` | USDC price of one token at the first bar that has a MACD value. |
   | `lastCloseUsdc` | USDC price of one token at the last bar. |
   | `candleCount` | Number of candles used. |
   | `percentOfBalance` | Percent of the USDC balance spent on each simulated buy. |
   | `poolReference` | Uniswap V4 pool id the candles came from. |

   Also name `initialBalanceUsdc` and `finalBalanceUsdc` under the table. For an entry, report the decision, the quote, and the `percentOfBalance` used. State that nothing is signed until the group accepts the multi-sign request. Never enable the plugin.
