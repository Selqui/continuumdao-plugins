# kairos-fixed-rate-borrow

Draft 0.1.0. Not a signed catalog release.

Quotes Kairos fixed-rate USDC and USDT borrows on Aave V3 on Ethereum. Each term includes the base rate, utilization fee, risk premium, protocol fee, all-in borrow APR, and the early-exit penalty. The same plugin opens a new fixed-rate loan, locks the rate on an Aave borrow that already exists, repays the Aave debt, and closes the Kairos swap.

Ethereum is fixed in the entrypoint. There is no chain argument.

## Install on a node

Copy this directory to `user_folder/plugins/kairos-fixed-rate-borrow/` on the node. In the node UI, open **AI Plugins**, review the permission card, and approve it before the entrypoint can run. The chat command is `/kairos-fixed-rate-borrow`.

The entrypoint needs `net:https` so it can read Ethereum. Reads use `rpcGateway` from this node's chain config for chain 1. If Ethereum is not an active chain, the tool stops. It does not take a Variable or another RPC. Writes return one `pi.signRequest` at a time. The KeyGen group reviews each request before anything is broadcast.

Leave `.trust.json`, `.mpa-state.json`, and `.position-state.json` on the node. Those files are local approval and position state, not part of the plugin source.
