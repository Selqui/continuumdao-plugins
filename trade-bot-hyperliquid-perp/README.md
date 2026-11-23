# trade-bot-hyperliquid-perp

Decides a Hyperliquid perpetual from a market name, a candle window, and one technical-analysis type from the market-data library.

The argument is a Hyperliquid market name such as `BTC`. A contract address is rejected. The name does not have to be saved on the node. Periods and entry settings are passed in from Host YAML `trade-desk.yaml`. Optional `momentum` and `candlestick` switches require that confirmation on the same side before an open or a close. Dry-run and backtest do not use real USDC. The tool returns an unsigned payload. It does not sign and it does not post the multi-sign request.

![Decision matrix](./decision-matrix.svg)

Draft 0.1.0. Not yet published.
