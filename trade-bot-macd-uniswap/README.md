# trade-bot-macd-uniswap

MACD 12/26/9 pullback entries for a ContinuumDAO MPA Wallet node. Version **v1.0.0**.

On a bullish cross below the zero line, after the MACD line has stayed below zero for at least `pullbackBars` bars (default 2), the plugin prepares a buy of the token with USDC on Uniswap V4. On a bearish cross above the zero line, after the same number of bars above zero, it prepares a sell of the token for USDC.

The entrypoint does not sign and does not broadcast. A live run returns an `unsignedPayload`. The agent opens the multi-sign request, and no order exists until the group accepts it.

## Run

From the node chat:

```text
/trade-bot-macd-uniswap WBTC 8453 4h 200 25 dry-run backtest
```

| Argument | Example | Meaning |
|---|---|---|
| Token name | `WBTC` | Registry symbol. The agent resolves the contract address. It does not guess one. |
| chainId | `8453` | Chain. 8453 is Base. |
| Interval | `4h` | `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, or `1w`. Default `4h`. |
| Candles | `200` | Keep the last this many bars. A backtest refuses fewer than 200. An entry refuses fewer than 100. Default `200`. |
| Percent | `25` | Percent of the USDC balance spent on each buy. `25%` is accepted. Default `50`. |
| Flags | `dry-run`, `live`, `backtest` | Either order. |

`backtest` only simulates. `dry-run` quotes and does not sign. `live` returns the unsigned payload. If you omit the flags, the run does a backtest and a dry-run entry.

Candles come from the Uniswap V4 Graph inside the plugin. The close used for MACD and the statistics is USDC per token. A positive percentage means the USDC spent to buy the token increased.

## Backtest table

Report one table with the columns **Metric**, **Value**, and **What it means**.

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

Name `initialBalanceUsdc` and `finalBalanceUsdc` under the table. The simulation starts at 1000 USDC unless you pass another `initialBalanceUsdc`.

## Node setup

The manifest asks for `user_folder:read`, `user_folder:write`, and `net:https`. Position state is stored under the plugin directory on the node.

Set these Variables on the node. The plugin checks that they exist and never reads the values.

| Variable | Used for |
|---|---|
| `THE_GRAPH_API_KEY` | Uniswap V4 candle fetch |
| `UNISWAP_API_KEY` | Trade quote and unsigned swap |

Known USDC addresses cover Ethereum, Base, Arbitrum, Optimism, Polygon, Linea, and Robinhood Chain. Another chain needs `usdcAddress`.
