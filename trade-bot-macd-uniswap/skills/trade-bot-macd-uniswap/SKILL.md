---
name: trade-bot-macd-uniswap
description: MACD 12/26/9 pullback entries on Uniswap V4 — buy a token with USDC on a bullish cross below the zero line, sell it for USDC on a bearish cross above the zero line. Load before computing a MACD signal, backtesting it, or building an unsigned Uniswap V4 payload.
---

# trade-bot-macd-uniswap

Four tools, one rule. **This plugin never signs and never broadcasts.** `macd_entry_order`
with `dryRun:false` returns an `unsignedPayload` — the agent opens the multi-sign request.

## Rule

MACD 12/26/9 on close prices via
`calculateTechnicalIndicator({ indicator: 'macd', params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } })`
from `@continuumdao/ctm-market-data` (`ta`).

- **Bullish Entry** — MACD line crosses **above** the signal line while below zero, and has
  been below zero for **≥ `pullbackBars`** bars ending on the cross bar. **Buy** the token with USDC.
- **Bearish Entry** — MACD line crosses **below** the signal line while above zero, after
  **≥ `pullbackBars`** bars above zero. **Sell** the token for USDC.

`pullbackBars` default **2**. A cross that does not satisfy the zero-line and pullback
conditions is `no-trade`. If `crossLookback > 0`, older bars are also checked; a trade is
taken only if the stored state allows it.

## Before calling any tool: resolve the token

The operator gives a **symbol or name**, not an address, and the entrypoint cannot call MCP
tools. Do this first:

1. Call **`continuum__get_token_registry`** with `symbol` (and `chain_id` from
   `get_chain_registry`). Do not guess, derive, or checksum an address.
2. Take `contract.contractAddress` and `contract.decimals` from the registry row.
3. Pass them as **`tokenAddress`** and `tokenDecimals`.
4. If the registry has no row, stop and say so. Never substitute a lookalike token. If the
   operator pasted an address themselves, use that and say where it came from.

Also needed: `chainId`, and the balance from **`agent_get_balance`** (pass as `balanceHuman`)
so `percentOfBalance` sizing does not need an RPC URL.

## Defaults

| Input | Default |
|---|---|
| `interval` | `4h` |
| `lookbackDays` | `60` (used only when `candleCount` is omitted) |
| `candleCount` | omitted on a direct tool call. The slash prompt defaults it to `200` and passes it through. The tool keeps the last this many bars. |
| `percentOfBalance` | `50` |
| `pullbackBars` | `2` |
| `dryRun` | `true` |
| `minCandles` (live) | **100** — refuse below this |
| `minBacktestCandles` | **200** — refuse below this |
| `feeBps` (backtest) | `30` |
| `initialBalanceUsdc` (backtest) | `1000` |

## Candles

Chart OHLCV tools return a thin summary: a bar count and a last price, and no candle rows.
Do not pass that summary into this plugin, and do not compute MACD from it.

`macd_backtest` and `macd_entry_order` fetch the Uniswap V4 Graph candles themselves.
Leave `dataSource` as `uniswap-v4` (the default). Pass `chainId` and `tokenAddress`.
The plugin tries the standard token/USDC fee tiers and uses the pool that has candles.
Pass `poolReference` only when you already know the bytes32 pool id.

`candleCount` keeps the last that many bars. `4h` and `200` is 200 four-hour candles.
The fetch lookback is raised so the pool can return that many, then the extra bars are dropped.
A backtest refuses a `candleCount` below 200. An entry refuses one below 100.

`macd_signal` does not fetch. Call it only when you already hold full candle rows.

`THE_GRAPH_API_KEY` must be set in Variables. The plugin does not read the value.
It is injected into `uniswapV4FetchOhlcv`.

The Graph close is token0 per token1, not USDC per token. On a WBTC/USDC pool that
number is a tiny fraction. The plugin inverts it when the pool is token/USDC and the
close is not already USDC per token. MACD, `pctProfit`, and `buyAndHoldPct` then use
that USDC price. A positive percentage means the USDC spent to buy the token increased.
`firstCloseUsdc` and `lastCloseUsdc` are those prices. Do not rescale them by token
decimals. `tokenDecimals` is only for sizing a live order.

## Tools

### `macd_signal` — pure, offline

`candles[]` or `closes[]`, optional `pullbackBars`, `crossLookback`, `fastPeriod`,
`slowPeriod`, `signalPeriod`. Returns `action` (`buy`/`sell`/`none`), `cross`, `zeroLine`,
`zeroBars`, `barsSinceCross`, `macd`, `signal`, `histogram`, `reason`.

### `macd_position` — stored state

`chainId`, `tokenAddress`, `interval`. Returns `{ state: 'long' | 'flat', entryAt, … }`.
`reset: true` clears one key back to flat. `listAll: true` dumps every key.
State lives in `plugins/trade-bot-macd-uniswap/.position-state.json`, keyed
`chainId:tokenAddress:interval`.

### `macd_backtest` — simulation, never signs

Needs **≥ 200 candles**. `dataSource: 'uniswap-v4'` is the default: this tool fetches
the Uniswap V4 Graph candles from `tokenAddress` (standard USDC fee tiers) or from
`poolReference` / `existingPool`. `dataSource: 'provided'` is only for full candle rows
already in hand. A chart-tool summary is not candle rows.

Pass `percentOfBalance` (default **50**). Each simulated buy spends that percent of the
current USDC balance.

Returns `initialBalanceUsdc`, `finalBalanceUsdc`, `finalBalanceRatioPct`, `pctProfit`,
`buyAndHoldPct`, `maxDrawdownPct`, `feeTotalUsdc`, `tradeCount`, `trades[]`, a
`balanceSeries` (downsampled to `maxSeriesPoints`, default 400) and the explicit
`assumptions[]`. Candle close is USDC per token; sells close the whole position; `feeBps`
is deducted per swap; no slippage, no gas, no intrabar fills.

When you report a backtest, use one table with the columns **Metric**, **Value**, and
**What it means**. Use these definitions:

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

Name `initialBalanceUsdc` and `finalBalanceUsdc` under the table.

### `macd_entry_order` — the live path

`chainId`, `tokenAddress`, plus the sizing and candle inputs above.

1. Fetch or accept bars. **Fewer than 100 → refuse.**
2. MACD → rule → `action`.
3. Read stored state. `buy` while **long** → suppressed. `sell` while **flat** → suppressed.
4. Size: `amountHuman`, else `percentOfBalance` × `balanceHuman` (or `balanceOf` via `rpcUrl`).
5. Quote `uniswapTradeQuote` (`EXACT_INPUT`, `swapper: pi.preferredKeyGenAddress()`).
6. **`dryRun` default true** → returns `decision: 'would-trade'`, the quote and
   `purposePreview`. No payload, no state change.
7. `dryRun:false` → **re-quotes immediately**, then returns:

```json
{ "decision": "trade",
  "unsignedPayload": { "chainId": 8453, "to": "0x…", "data": "0x…", "value": "0", "purpose": "Bullish Entry MACD…" },
  "positionAfter": { "state": "long" } }
```

State is written **before** the payload is returned, so a second run cannot repeat the buy.
If the state write fails, no payload is returned.

## What the agent must do with an unsigned payload

The plugin stops at the payload. To trade, the agent opens the sign request itself
(`pi.signRequest` / the multi-sign request flow) with `chainId`, `to`, `data`, `value` and
`purpose`, and the group reviews it. Ask the operator before going on-chain. The operator
may instead run this from cron and do Get Sig / Execute when the other nodes have agreed.

## SkipPermit2

`uniswapTradeQuote` and `uniswapCreateSwap` as documented in the loaded library index name
**no permit2 field**, so this entrypoint passes **no permit2 argument**. The field name was
not invented. If the library index later names it, add it to `buildSwap()` and raise the
version. Until then, do not claim the swap is explicitly on the SkipPermit2 path — it is on
the library's default path.

## Permissions a review will flag

- `user_folder:write` — position state (`.position-state.json`). Also `user_folder:read`.
- `net:https` — Uniswap Trade API, optional RPC balance read, candle fetch.
- `UNISWAP_API_KEY` Variable injected into `uniswapApiKey` for the quote and swap calls,
  limited to `uniswapTradeQuote` and `uniswapCreateSwap`. Checked with
  `pi.variableConfigured('UNISWAP_API_KEY')`; the plugin never sees the value.
- No shell, no hooks, no Express, no HTTP routes.

## Notes

- The swapper is always `pi.preferredKeyGenAddress()`. No address is hard-coded.
- A chain without a default USDC entry is refused rather than guessed.
- `dataSource: 'uniswap-v4'` is the default and fetches full candles. `provided` accepts
  full candle rows only. A chart-tool summary has no rows.
- `THE_GRAPH_API_KEY` is injected into `uniswapV4FetchOhlcv` as `theGraphApiKey`. The
  plugin never sees the value.
