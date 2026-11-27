# trade-bot-hyperliquid-perp

Decides a Hyperliquid perpetual from a market name, a candle window, and one technical analysis. A clear idea can open a position or close the one that is open. Optional rules can move the stop, trail it, add size, or remove size once price has moved from the entry toward the target. Dry-run and backtest use a paper balance. Live returns an unsigned payload. The plugin does not sign it and does not post it.

The word `message` posts an account note before that decision on dry-run and live. The note is the spot USDC still available on the preferred KeyGen and the unrealised profit or loss of its open perpetuals. The same text goes to the KeyGen and, when a Telegram webhook is configured, to that operator chat. Backtest does not send it.

The market name does not have to be saved on the node. A contract address is rejected. Periods and entry settings come from `trade-desk.yaml`. Candlestick analysis runs inside the plugin. A separate request for a chart still uses the chart tools.

## Setup

On the other nodes in the group, open Node => AI Agent => Cron and set `auto-accept-sign-request` to Active and Instant. On this node, set `auto-sign-and-broadcast` to Active and Instant in the same place. A node can hold only one Instant job, so the accept job stays on the other nodes and the broadcast job stays on this one.

Each run checks only this node, the one where the command is entered. The check passes when `auto-sign-and-broadcast` is Active and Instant. It does not read the other nodes. If that job is not both Active and Instant, the result includes `setupNotice`. That text starts with the path `Node => AI Agent => Cron`, tells you to set `auto-accept-sign-request` to Active and Instant on the other nodes, and tells you to set `auto-sign-and-broadcast` on this node. It then says you may miss trades if you rely on a person, or on AI actionable agreement and broadcasting, which can be slow.

## Arguments

- `asset` — Hyperliquid market name, such as `BTC`. A `0x` contract address is rejected.
- `interval` — `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`.
- `candleCount` — number of candles. An integer of at least 2.
- `analysisType` — `trend_structure`, `elliott_waves`, `key_levels`, `key_level_fibonacci`, `divergence`, `range_volatility`, `bollinger_bands`, `donchian_breakout`, `supertrend`, `ichimoku`, `z_score`, `moving_averages`, `chart_patterns`, `momentum`, `candlestick_patterns`.
- `mode` — `dry-run` (default), `backtest`, or `live`.
- `momentum` — omit it (default) or `on`. When on, an open must match the momentum idea. A close does not use it.
- `candlestick` — omit it (default) or `on`. When on, an open must match the candlestick idea. A close does not use it.
- `percent` — a positive number, default `50`. The fraction of the notional Hyperliquid will allow.
- `stop-to-entry` — optional `XX YY`, such as `50 5`. `XX` is above 0 and at most 100. `YY` is 0 or more and below `XX`. Moves the stop once.
- `trailing-stop` — optional `XX YY`, such as `50 5`. Each value is above 0 and at most 100, and `YY` is below `XX`, so the trigger price stays ahead of the stop. Sets the stop back from the previous close, and tightens it on later closes.
- `add-to-position` — optional `XX YY`, such as `50 25`. Each value is above 0 and at most 100. Adds that percent of free collateral once.
- `remove-from-position` — optional `XX YY`, such as `75 50`. Each value is above 0 and at most 100. Closes that percent of the position once. `100` closes it.
- `message` — omit it, or include the word. On dry-run and live, the plugin posts the account note below before it fetches candles or decides. Backtest does not post.

The four position rules need a target on the open position. `XX` is how far the previous candle close must travel from the entry toward that target. On a long from 10 to 20, `50` means the previous close is 15 or higher. On a short from 20 to 10, `50` means the previous close is 15 or lower.

## Account message

Include `message` on dry-run or live and the plugin reads the preferred KeyGen on Hyperliquid before the analysis. Backtest skips that read and does not post, even when the word is present. The decision after a dry-run or live note is unchanged: dry-run stays on paper, and live still returns an unsigned payload.

The note has two figures.

- **Spot USDC available** is the KeyGen spot USDC that is not on hold. That is the collateral still sitting in spot.
- **Unrealised PnL** is the sum of unrealised profit or loss on open perpetual positions. Each position contributes its own unrealised PnL. A book with no open perpetual is `0.00`. Amounts are shown to two decimal places. A profit has a leading `+`.

The text looks like this:

```text
Spot USDC available: 1250.00. Unrealised PnL: -42.18.
```

That text is the body of a KeyGen message on the preferred KeyGen, so the other nodes receive it. Saving the thread needs `user_folder:write`, which this plugin declares. This plugin keeps one thread for each KeyGen address. The first note opens it. The title of that root message is `Hyperliquid account`. Every later note is a reply to that root, with no title, so it does not open a second thread. The root id is stored in `.position-state.json` on the node and is left out of the published archive. `keyGenThreadId` is that root. `keyGenMessageId` is the note from this run. If the root message has been deleted, the next note opens a new thread and later notes reply to that one.

The same body is then sent with `sendTelegram`, which uses the node's Telegram webhook when one is configured. `telegramSent` is true when that send is accepted. When no Telegram webhook is configured, the KeyGen post still stands, `telegramSent` is false, and the decision continues. A Telegram send that fails for another reason is returned as `telegramError`. That does not cancel the decision. A failed KeyGen post does. The tool returns that error and does not continue to an order.

The plugin sends both. The agent should quote `accountMessage` and should not post a second copy.

```text
/trade-bot-hyperliquid-perp BTC 4h 200 supertrend message
```

`message` can sit with the other words. Live posts the note, then returns an unsigned payload when the idea calls for one:

```text
/trade-bot-hyperliquid-perp ETH 4h 200 supertrend live message
```

The same word on a backtest does not post:

```text
/trade-bot-hyperliquid-perp ETH 4h 200 supertrend backtest 50 message
```

## Examples

A dry-run is the default. This asks for the current ETH idea on 200 candles of 4h supertrend and does not place a paper trade:

```text
/trade-bot-hyperliquid-perp ETH 4h 200 supertrend
```

A backtest replays the idea across the window. This paper-trades BTC on 400 candles of 4h chart patterns, using half of the notional the account can support:

```text
/trade-bot-hyperliquid-perp BTC 4h 400 chart_patterns backtest 50
```

`momentum` and `candlestick` gate opens only. This requires both confirmations before a donchian open, and still closes on an opposite idea:

```text
/trade-bot-hyperliquid-perp BTC 30m 400 donchian_breakout backtest momentum candlestick
```

Live reads the KeyGen position and returns an unsigned payload when the idea calls for one:

```text
/trade-bot-hyperliquid-perp HYPE 1h 200 z_score live
```

The same command can carry position rules. Words come in any order. A bare number is `percent`. Each rule takes the two numbers that follow it:

```text
/trade-bot-hyperliquid-perp BTC 30m 400 donchian_breakout backtest 50 stop-to-entry 50 5 trailing-stop 50 5 add-to-position 60 25 remove-from-position 80 40
```

### Stop to entry

`stop-to-entry 50 5` runs once. Entry 10 and target 20 put the long stop at `10 + 5% × (20 − 10) = 10.5` after a previous close of 15 or higher. Entry 20 and target 10 put the short stop at `20 − 5% × (20 − 10) = 19.5` after a previous close of 15 or lower.

```text
/trade-bot-hyperliquid-perp ETH 30m 400 supertrend backtest stop-to-entry 50 5
```

### Trailing stop

`trailing-stop 50 5` measures the same 50% trip, then sets the stop back from that close by 5% of the entry-to-target range. The second percent has to be below the first, so that trigger price stays ahead of the stop. Entry 10, target 20, and a close of 15 put a long stop at `15 − 0.5 = 14.5`. A later close of 16 moves it to 15.5. A close that would loosen it leaves the stop where it is. The short from 20 to 10, with a close of 15, puts the stop at 15.5.

```text
/trade-bot-hyperliquid-perp BTC 15m 400 supertrend backtest trailing-stop 50 5
```

### Add and remove

`add-to-position 50 25` adds 25% of the collateral still free under the same notional cap, once the previous close has covered half the distance to the target. `remove-from-position 75 50` later closes half of the position. `remove-from-position 75 100` closes all of it.

```text
/trade-bot-hyperliquid-perp BTC 1h 300 donchian_breakout backtest add-to-position 50 25 remove-from-position 75 50
```

A backtest ledger row records a stop move as `stop-to-entry` or `trailing-stop`, an add as `add`, and a partial remove as `remove`. A remove of the whole position closes the trade with reason `remove`.

![Decision matrix](./decision-matrix.svg)

Version **v1.2.1**.
