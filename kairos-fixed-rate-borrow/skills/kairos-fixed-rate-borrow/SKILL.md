---
name: kairos-fixed-rate-borrow
description: Quote Kairos fixed-rate USDC or USDT borrows on Aave V3 Ethereum by term, including fees and the early-exit penalty, then open, lock, repay, exit, or settle. Load before showing a fixed borrow quote or sending one of those transactions.
---

# kairos-fixed-rate-borrow

Ethereum mainnet only. There is no chain argument. Reads use the RPC from this node's chain config for Ethereum. If Ethereum is not an active chain, the tool stops. Do not pass another RPC. The loan stays on Aave V3. The Kairos swap is the rate lock beside it.

Tools, once the entrypoint is approved:

- `plugin_kairos-fixed-rate-borrow_rates`
- `plugin_kairos-fixed-rate-borrow_positions`
- `plugin_kairos-fixed-rate-borrow_transact`

If a tool is missing, say the entrypoint is installed but not approved. Do not invent a quote or a transaction.

## Show rates before any open or lock

Call `rates` with `asset` (`USDC` or `USDT`) before `open` or `lock`. Optional `notional` is the borrow size in tokens. The default is 10,000. The utilization fee depends on that size, so do not reuse a quote from a different notional.

Show one row per term. Use these columns:

| Column | What it means |
|---|---|
| `termDays` | Length of the rate lock. |
| `allInBorrowAprPercent` | Fixed swap APR plus the protocol-fee APR. This is the fee-included borrow rate. |
| `fixedSwapAprPercent` | All-in Kairos swap rate for this notional (`calculateSwapRate`). |
| `baseAprPercent` | Base rate before utilization fee and risk premium. |
| `utilizationFeeAprPercent` | Seasoned utilization fee for this notional. |
| `riskPremiumAprPercent` | What is left of the swap rate after base and utilization fee. |
| `protocolFeeAprPercent` | Annualized protocol fee. |
| `protocolFeeAmount` | Protocol fee in the borrow asset for this notional and term. |
| `variableAprPercent` | Trailing reference-oracle rate. Null when the oracle window is not valid. |
| `earlyExitAllowed` | Whether the swap can be closed before expiry. |
| `earlyExitFeePercentOfNetCloseout` | Early-exit fee as a percent of the net closeout, not of the notional. |
| `liquidationIncentivePercent` | Liquidator share of the owing side's collateral. |
| `availableNotional` | Largest notional the pool can back right now. |
| `recommended` | Highest available liquidity for that term. Pass that row's `marketId` to `open` or `lock`. |

A row with `tradable: false` has no available notional. Do not open it.

## Positions

`positions` reads the preferred KeyGen. It lists Aave variable debt for USDC and USDT beside each Kairos swap. A debt with no swap is an unhedged loan. A swap with no debt is a hedge whose loan was already repaid.

## Transactions

`transact` returns one sign request. After the group signs and it is broadcast, call `transact` again with the same arguments. Repeat until `remaining` is empty. Do not batch the steps into one request.

`action` is one of:

- `open` — new Aave borrow plus the Kairos swap. `borrowAmount` defaults to `notional`. Collateral symbols: `ETH` (native ether), `WETH`, `wstETH`, `WBTC`, `cbBTC`. Omit collateral or pass `collateralAmount: "0"` to borrow against collateral already on Aave. `minHealthFactor` defaults to `1.5`.
- `lock` — buy the Kairos swap against a variable borrow that already exists. Does not open a new Aave loan. The KeyGen must hold the borrow asset to pay the swap.
- `repay` — repay Aave variable debt. `amount` may be `max`. This does not close the Kairos swap. Ask before also exiting or settling the swap.
- `exit` — `exitSwapEarly` when the market allows it and the swap has not expired. Default slippage is 100 bps on the quoted net the buyer receives. When the closeout pays the pool, the slippage floor is off.
- `settle` — `makePayment` after expiry. Before expiry, use `exit`.

The `purpose` text is what the group reviews. Read it back to the operator. It names the asset, term, amounts, all-in APR, protocol fee, and early-exit penalty.

`rateSlippageBps` defaults to 50. That is added to the quoted fixed rate as the ceiling, in APR basis points (50 means half a percentage point).
