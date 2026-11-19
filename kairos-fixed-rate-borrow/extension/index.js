import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  parseUnits,
} from 'viem'

const CHAIN_ID = 1
const YEAR = 365n * 24n * 60n * 60n
const WAD = 10n ** 18n
const RAY = 10n ** 27n
const VARIABLE_WINDOW_SECONDS = 86400n
const DEFAULT_NOTIONAL = '10000'
const DEFAULT_RATE_SLIPPAGE_BPS = 50n
const DEFAULT_EXIT_SLIPPAGE_BPS = 100n
const DEFAULT_MIN_HEALTH = '1.5'
const SWAP_STORE_DEPLOYED_BLOCK = 25_856_185n
const LOG_CHUNK = 500_000n

const ADDRESSES = {
  router: '0x1f8651daaD4500140E083A7303d9c53240654a6C',
  swapStore: '0x8d271F5196Dd19E9C4A117ff8053285134582895',
  views: '0x63b3b36dFFf576aF5FCDA97C09ebDe21F8a1C976',
  admin: '0x270C1E07Bb33a57B2081012DeB9ba00b40268999',
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
}

const BORROW = {
  USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  USDT: { symbol: 'USDT', address: ADDRESSES.usdt, decimals: 6 },
}

const COLLATERAL = {
  WETH: { symbol: 'WETH', address: ADDRESSES.weth, decimals: 18, native: false },
  WSTETH: { symbol: 'wstETH', address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18, native: false },
  WBTC: { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, native: false },
  CBBTC: { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, native: false },
}

const routerAbi = parseAbi([
  'function SWAP_CORE() view returns (address)',
  'function POOL() view returns (address)',
  'function WETH() view returns (address)',
  'function referenceOracleOf(address) view returns (address)',
  'function openFixedRateLoan((address collateralAsset,uint256 collateralAmount,address borrowAsset,uint256 borrowAmount,bytes32 marketId,uint256 notional,int256 rateBound,uint256 maxTotalIn,uint256 minHealthFactor,uint256 deadline) p,(uint256 deadline,bytes signature) delegationSig,(uint8 kind,uint256 nonce,uint256 deadline,bytes signature) collateralSig) payable returns (bytes32 swapId, uint256 loanOut)',
])

const coreAbi = parseAbi([
  'function admin() view returns (address)',
  'function getAllMarketIds() view returns (bytes32[])',
  'function markets(bytes32 marketId) view returns (address baseSwapRateOracle, address referenceRateOracle, address swapToken, uint64 leverageMultiplier, uint32 swapTerm, uint8 rateType, uint32 numBuckets, bool exists, bytes32 correspondingMarketId, uint256 poolTotalShares, uint256 poolTotalCollateral, uint256 poolLockedCollateral, uint256 utilFeeSlopeWad, uint256 kinkUtilization, uint256 maxKinkFeeWad, bool earlyExitAllowed, uint256 earlyExitFee, uint256 liquidationIncentive, bool terminated, address marketOwner, uint32 bucketInterval, address riskPremiumOracle, bool lpWhitelistEnabled, uint88 minCollateral)',
  'function swapPositions(bytes32 swapId) view returns (bytes32 marketId, address userAddress, bool settled, bool isEarlyExit, uint256 collateralBalance, uint256 notionalAmount, int256 baseRate, int256 swapRate, uint256 entryTimestamp, uint256 entryFloatingIndex, uint256 poolCollateralBacking, uint256 utilFee, uint256 riskPremium, uint256 liquidationBounty)',
  'function getSwapNetAmount(bytes32 swapId) view returns (uint256 netAmount, uint8 netRecipient)',
  'function buySwap(bytes32 marketId, uint256 notionalAmount, address onBehalfOf, int256 rateBound, uint256 maxMarkup, uint256 maxTotalIn) returns (bytes32)',
  'function makePayment(bytes32[] swapIds) returns ((uint256 settlementAmount, uint8 netRecipient)[])',
  'function exitSwapEarly((bytes32 swapId, uint256 minExitAmount)[] requests, address onBehalfOf) returns ((uint256 settlementAmount, uint8 netRecipient)[])',
])

const viewsAbi = parseAbi([
  'function calculateSwapRate(bytes32 marketId, uint256 notionalAmount) view returns (int256)',
  'function previewUtilizationFee(bytes32 marketId, uint256 notionalAmount) view returns (uint256)',
  'function getBaseRate(bytes32 marketId) view returns (int256)',
  'function getCalculatedAvailableLiquidity(bytes32 marketId) view returns (uint256)',
  'function viewCurrentReferenceRate(bytes32 marketId, uint256 windowSeconds) view returns (int256 rateWad, bool isValid)',
])

const adminAbi = parseAbi([
  'function getFeeConfig() view returns (uint256 feeRate, uint256 creatorFeeShare, address protocolMultisig)',
])

const poolAbi = parseAbi([
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
])

const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const debtAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function borrowAllowance(address fromUser, address toUser) view returns (uint256)',
  'function approveDelegation(address delegatee, uint256 amount)',
])

const swapCreatedEvent = parseAbiItem(
  'event SwapCreated(bytes32 indexed marketId, bytes32 indexed swapId, address indexed onBehalfOf, address caller, uint256 notionalAmount, uint256 buyerCollateral, uint256 poolCollateralBacking, int256 swapRate, int256 baseRate, uint256 entryTimestamp, uint256 entryFloatingIndex, uint256 utilFee, uint256 riskPremium, uint32 swapTerm, uint8 rateType, uint256 protocolFee, uint256 liquidationBounty)',
)

const clients = new Map()

function nodeEthereumRpc(pi) {
  const chains = pi && typeof pi.chainConfigs === 'function' ? pi.chainConfigs() : []
  const row = chains.find((chain) => {
    const type = String(chain && chain.chainType ? chain.chainType : '').trim().toLowerCase()
    return type === 'ethereum' && String(chain && chain.chainId != null ? chain.chainId : '').trim() === '1'
  })
  const rpc = row && String(row.rpcGateway || '').trim()
  if (!rpc) throw new Error('Ethereum is not an active chain on this node')
  return rpc
}

function clientFor(rpcUrl) {
  const url = String(rpcUrl || '').trim()
  if (!url) throw new Error('Ethereum is not an active chain on this node')
  if (!/^https?:\/\//i.test(url)) throw new Error('Ethereum chain config rpcGateway must be an http(s) URL')
  let client = clients.get(url)
  if (client) return client
  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
    contracts: {
      multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    },
  })
  client = createPublicClient({ chain, transport: http(url) })
  clients.set(url, client)
  return client
}

function sameAddress(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

function asStruct(raw, keys) {
  if (raw == null || typeof raw !== 'object') return raw
  const out = {}
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]] = raw[keys[i]] != null ? raw[keys[i]] : raw[i]
  }
  return out
}

const MARKET_KEYS = [
  'baseSwapRateOracle', 'referenceRateOracle', 'swapToken', 'leverageMultiplier', 'swapTerm', 'rateType',
  'numBuckets', 'exists', 'correspondingMarketId', 'poolTotalShares', 'poolTotalCollateral', 'poolLockedCollateral',
  'utilFeeSlopeWad', 'kinkUtilization', 'maxKinkFeeWad', 'earlyExitAllowed', 'earlyExitFee', 'liquidationIncentive',
  'terminated', 'marketOwner', 'bucketInterval', 'riskPremiumOracle', 'lpWhitelistEnabled', 'minCollateral',
]

const POSITION_KEYS = [
  'marketId', 'userAddress', 'settled', 'isEarlyExit', 'collateralBalance', 'notionalAmount', 'baseRate', 'swapRate',
  'entryTimestamp', 'entryFloatingIndex', 'poolCollateralBacking', 'utilFee', 'riskPremium', 'liquidationBounty',
]

const RESERVE_KEYS = [
  'configuration', 'liquidityIndex', 'currentLiquidityRate', 'variableBorrowIndex', 'currentVariableBorrowRate',
  'currentStableBorrowRate', 'lastUpdateTimestamp', 'id', 'aTokenAddress', 'stableDebtTokenAddress',
  'variableDebtTokenAddress', 'interestRateStrategyAddress', 'accruedToTreasury', 'unbacked', 'isolationModeTotalDebt',
]

function asMarket(raw) {
  return asStruct(raw, MARKET_KEYS)
}

function asPosition(raw) {
  return asStruct(raw, POSITION_KEYS)
}

function asReserve(raw) {
  return asStruct(raw, RESERVE_KEYS)
}

async function readMarket(client, marketId) {
  return asMarket(await client.readContract({
    address: ADDRESSES.swapStore,
    abi: coreAbi,
    functionName: 'markets',
    args: [marketId],
  }))
}

async function readPosition(client, swapId) {
  return asPosition(await client.readContract({
    address: ADDRESSES.swapStore,
    abi: coreAbi,
    functionName: 'swapPositions',
    args: [swapId],
  }))
}

async function readReserve(client, asset) {
  return asReserve(await client.readContract({
    address: ADDRESSES.pool,
    abi: poolAbi,
    functionName: 'getReserveData',
    args: [asset],
  }))
}

function feeRateOf(config) {
  return config && config.feeRate != null ? config.feeRate : config[0]
}

function abs(value) {
  return value < 0n ? -value : value
}

function wadPercent(wad) {
  if (wad == null) return null
  const neg = wad < 0n
  const v = neg ? -wad : wad
  const scaled = (v * 100n * 10000n) / WAD
  const whole = scaled / 10000n
  const frac = (scaled % 10000n).toString().padStart(4, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

function amountText(value, decimals) {
  return formatUnits(value, decimals)
}

function isBytes32(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''))
}

function bps(value, fallback) {
  const n = value == null || value === '' ? fallback : BigInt(value)
  if (n < 0n || n > 10_000n) throw new Error('slippage bps must be between 0 and 10000')
  return n
}

function knownBorrow(asset) {
  if (!asset) throw new Error('asset is required')
  const text = String(asset).trim()
  if (text.startsWith('0x')) {
    const address = getAddress(text)
    const known = Object.values(BORROW).find((row) => sameAddress(row.address, address))
    if (known) return known
    return { symbol: null, address, decimals: null }
  }
  const known = BORROW[text.toUpperCase()]
  if (!known) throw new Error('asset must be USDC or USDT')
  return known
}

async function borrowAsset(client, asset) {
  const row = knownBorrow(asset)
  if (row.decimals != null && row.symbol) return row
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: row.address, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address: row.address, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
  ])
  return { symbol: String(symbol), address: row.address, decimals: Number(decimals) }
}

function knownCollateral(asset) {
  const text = String(asset || '').trim()
  if (!text || text === '0' || text.toLowerCase() === 'none') return null
  if (text.toUpperCase() === 'ETH') {
    return { symbol: 'ETH', address: getAddress(ADDRESSES.weth), decimals: 18, native: true }
  }
  if (text.startsWith('0x')) {
    const address = getAddress(text)
    const known = Object.values(COLLATERAL).find((row) => sameAddress(row.address, address))
    if (known) return { ...known, address: getAddress(known.address) }
    return { symbol: null, address, decimals: null, native: false }
  }
  const key = text.toUpperCase() === 'WSTETH' ? 'WSTETH' : text.toUpperCase() === 'CBBTC' ? 'CBBTC' : text.toUpperCase()
  const known = COLLATERAL[key]
  if (!known) throw new Error('collateralAsset must be ETH, WETH, wstETH, WBTC, or cbBTC')
  return { ...known, address: getAddress(known.address) }
}

async function collateralAsset(client, asset) {
  const row = knownCollateral(asset)
  if (!row || row.decimals != null) return row
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: row.address, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address: row.address, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
  ])
  return { ...row, symbol: String(symbol), decimals: Number(decimals) }
}

async function assertDeployment(client) {
  const [core, pool, weth, admin] = await Promise.all([
    client.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: 'SWAP_CORE' }),
    client.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: 'POOL' }),
    client.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: 'WETH' }),
    client.readContract({ address: ADDRESSES.swapStore, abi: coreAbi, functionName: 'admin' }),
  ])
  if (!sameAddress(core, ADDRESSES.swapStore) || !sameAddress(pool, ADDRESSES.pool) || !sameAddress(weth, ADDRESSES.weth)) {
    throw new Error('Kairos router deployment does not match this plugin')
  }
  if (!sameAddress(admin, ADDRESSES.admin)) {
    throw new Error('Kairos admin deployment does not match this plugin')
  }
}

async function multicall(client, contracts) {
  const out = []
  for (let i = 0; i < contracts.length; i += 30) {
    const part = await client.multicall({ contracts: contracts.slice(i, i + 30), allowFailure: true })
    out.push(...part)
  }
  return out
}

function call(address, abi, functionName, args) {
  return { address, abi, functionName, args }
}

async function quoteMarket(client, marketId, market, notional, feeRate, decimals) {
  const calls = [
    call(ADDRESSES.views, viewsAbi, 'calculateSwapRate', [marketId, notional]),
    call(ADDRESSES.views, viewsAbi, 'previewUtilizationFee', [marketId, notional]),
    call(ADDRESSES.views, viewsAbi, 'getBaseRate', [marketId]),
    call(ADDRESSES.views, viewsAbi, 'getCalculatedAvailableLiquidity', [marketId]),
    call(ADDRESSES.views, viewsAbi, 'viewCurrentReferenceRate', [marketId, VARIABLE_WINDOW_SECONDS]),
  ]
  if (market.correspondingMarketId && market.correspondingMarketId !== `0x${'00'.repeat(32)}`) {
    calls.push(call(ADDRESSES.views, viewsAbi, 'getBaseRate', [market.correspondingMarketId]))
  }
  const results = await multicall(client, calls)
  if (results.slice(0, 4).some((row) => row.status !== 'success')) {
    const failed = results.find((row) => row.status !== 'success')
    throw new Error(failed && failed.error ? String(failed.error.shortMessage || failed.error.message || failed.error) : 'quote failed')
  }
  const swapRate = results[0].result
  const utilFee = results[1].result
  const baseRate = results[2].result
  const available = results[3].result
  const variableRaw = results[4].status === 'success' ? results[4].result : null
  const variable = variableRaw ? asStruct(variableRaw, ['rateWad', 'isValid']) : null
  const twinBase = results[5] && results[5].status === 'success' ? results[5].result : baseRate
  const riskPremium = swapRate - baseRate - BigInt(utilFee)
  const term = BigInt(market.swapTerm)
  const protocolFee = (notional * feeRate * term) / (YEAR * WAD)
  const feeInclusive = (abs(baseRate) > abs(twinBase) ? abs(baseRate) : abs(twinBase)) + utilFee + (riskPremium > 0n ? riskPremium : 0n)
  const rateForCollateral = feeInclusive > abs(swapRate) ? feeInclusive : abs(swapRate)
  const collateralEst = (notional * rateForCollateral * term) / (YEAR * WAD)
  const bountyEst = (collateralEst * market.liquidationIncentive) / WAD
  const maxTotalIn = ((collateralEst + bountyEst + protocolFee) * 2n) || 1n
  const variableWad = variable && variable.isValid ? variable.rateWad : null
  return {
    marketId,
    termSeconds: Number(market.swapTerm),
    termDays: Number(market.swapTerm) / 86400,
    fixedSwapAprPercent: wadPercent(swapRate),
    baseAprPercent: wadPercent(baseRate),
    utilizationFeeAprPercent: wadPercent(utilFee),
    riskPremiumAprPercent: wadPercent(riskPremium),
    protocolFeeAprPercent: wadPercent(feeRate),
    protocolFeeAmount: amountText(protocolFee, decimals),
    allInBorrowAprPercent: wadPercent(swapRate + feeRate),
    variableAprPercent: variableWad == null ? null : wadPercent(variableWad),
    variableRateWindowSeconds: Number(VARIABLE_WINDOW_SECONDS),
    earlyExitAllowed: market.earlyExitAllowed,
    earlyExitFeePercentOfNetCloseout: wadPercent(market.earlyExitFee),
    liquidationIncentivePercent: wadPercent(market.liquidationIncentive),
    availableNotional: amountText(available, decimals),
    availableRaw: available,
    tradable: available > 0n,
    swapRate,
    feeRate,
    maxTotalIn,
    notional,
  }
}

export async function readRates({ rpcUrl, asset, notional }) {
  const client = clientFor(rpcUrl)
  await assertDeployment(client)
  const token = await borrowAsset(client, asset)
  const notionalRaw = parseUnits(notional == null || notional === '' ? DEFAULT_NOTIONAL : String(notional), token.decimals)
  if (notionalRaw <= 0n) throw new Error('notional must be greater than 0')
  const [ids, oracle, feeConfig] = await Promise.all([
    client.readContract({ address: ADDRESSES.swapStore, abi: coreAbi, functionName: 'getAllMarketIds' }),
    client.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: 'referenceOracleOf', args: [token.address] }),
    client.readContract({ address: ADDRESSES.admin, abi: adminAbi, functionName: 'getFeeConfig' }),
  ])
  if (sameAddress(oracle, '0x0000000000000000000000000000000000000000')) {
    throw new Error(`${token.symbol || token.address} is not a Kairos fixed-rate borrow asset`)
  }
  const markets = await multicall(
    client,
    ids.map((id) => call(ADDRESSES.swapStore, coreAbi, 'markets', [id])),
  )
  const selected = []
  for (let i = 0; i < ids.length; i++) {
    const row = markets[i]
    if (row.status !== 'success') continue
    const market = asMarket(row.result)
    if (!market.exists || market.terminated) continue
    if (Number(market.rateType) !== 0) continue
    if (!sameAddress(market.swapToken, token.address)) continue
    if (!sameAddress(market.referenceRateOracle, oracle)) continue
    selected.push({ id: ids[i], market })
  }
  const quotes = []
  for (const entry of selected) {
    try {
      quotes.push(await quoteMarket(client, entry.id, entry.market, notionalRaw, feeRateOf(feeConfig), token.decimals))
    } catch (err) {
      quotes.push({
        marketId: entry.id,
        termSeconds: Number(entry.market.swapTerm),
        termDays: Number(entry.market.swapTerm) / 86400,
        tradable: false,
        availableRaw: 0n,
        error: err && err.message ? String(err.message) : String(err),
      })
    }
  }
  quotes.sort((a, b) => a.termDays - b.termDays || (a.availableRaw < b.availableRaw ? 1 : a.availableRaw > b.availableRaw ? -1 : 0))
  const seenTerm = new Set()
  for (const row of quotes) {
    if (row.error || !row.tradable) {
      row.recommended = false
      continue
    }
    const key = String(row.termSeconds)
    row.recommended = !seenTerm.has(key)
    seenTerm.add(key)
  }
  return {
    chainId: CHAIN_ID,
    asset: token.symbol || token.address,
    assetAddress: token.address,
    notional: amountText(notionalRaw, token.decimals),
    rates: quotes.map((row) => {
      const { swapRate, feeRate, maxTotalIn, notional: rawNotional, availableRaw, ...rest } = row
      return rest
    }),
  }
}

function deploymentBlock() {
  return SWAP_STORE_DEPLOYED_BLOCK
}

async function userSwapLogs(client, owner) {
  const from = await deploymentBlock(client, ADDRESSES.swapStore)
  const head = await client.getBlockNumber()
  let chunk = LOG_CHUNK
  const logs = []
  for (let start = from; start <= head; ) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n
    try {
      const part = await client.getLogs({
        address: ADDRESSES.swapStore,
        event: swapCreatedEvent,
        args: { onBehalfOf: owner },
        fromBlock: start,
        toBlock: end,
      })
      logs.push(...part)
      start = end + 1n
    } catch (err) {
      const text = `${err && err.details ? err.details : ''} ${err && err.shortMessage ? err.shortMessage : ''} ${err && err.message ? err.message : ''}`.toLowerCase()
      const rangeLimited = /range|too large|exceeds|limit of|max(imum)? .*block/.test(text)
      if (!rangeLimited || chunk <= 100n) throw err
      chunk = chunk / 2n
    }
  }
  return logs
}

function debtTokenOf(reserve) {
  return reserve.variableDebtTokenAddress
}

export async function readPositions({ rpcUrl, owner }) {
  const client = clientFor(rpcUrl)
  await assertDeployment(client)
  const account = getAddress(owner)
  const logs = await userSwapLogs(client, account)
  const ids = []
  const seen = new Set()
  for (const log of logs) {
    const id = log.args.swapId
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  const positions = ids.length
    ? await multicall(client, ids.map((id) => call(ADDRESSES.swapStore, coreAbi, 'swapPositions', [id])))
    : []
  const swaps = []
  for (let i = 0; i < ids.length; i++) {
    if (positions[i].status !== 'success') continue
    const position = asPosition(positions[i].result)
    if (position.entryTimestamp === 0n) continue
    swaps.push({ swapId: ids[i], position })
  }
  const marketIds = [...new Set(swaps.map((row) => row.position.marketId))]
  const marketRows = marketIds.length
    ? await multicall(client, marketIds.map((id) => call(ADDRESSES.swapStore, coreAbi, 'markets', [id])))
    : []
  const markets = new Map()
  marketIds.forEach((id, i) => {
    if (marketRows[i].status === 'success') markets.set(id, asMarket(marketRows[i].result))
  })
  const tokens = new Map(Object.values(BORROW).map((row) => [row.address.toLowerCase(), row]))
  for (const market of markets.values()) {
    const key = String(market.swapToken).toLowerCase()
    if (!tokens.has(key)) tokens.set(key, { symbol: null, address: getAddress(market.swapToken), decimals: null })
  }
  for (const row of tokens.values()) {
    if (row.decimals != null) continue
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: row.address, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: row.address, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
    ])
    row.decimals = Number(decimals)
    row.symbol = String(symbol)
  }
  const now = BigInt((await client.getBlock()).timestamp)
  const swapRows = swaps.map((row) => {
    const market = markets.get(row.position.marketId)
    const token = market ? tokens.get(String(market.swapToken).toLowerCase()) : null
    const decimals = token ? token.decimals : 18
    const expiry = row.position.entryTimestamp + BigInt(market ? market.swapTerm : 0)
    return {
      swapId: row.swapId,
      marketId: row.position.marketId,
      asset: token ? token.symbol || token.address : null,
      notional: amountText(row.position.notionalAmount, decimals),
      settled: row.position.settled,
      earlyExit: row.position.isEarlyExit,
      expired: !row.position.settled && now >= expiry,
      entryTimestamp: Number(row.position.entryTimestamp),
      expiryTimestamp: Number(expiry),
      termDays: market ? Number(market.swapTerm) / 86400 : null,
      fixedSwapAprPercent: wadPercent(row.position.swapRate),
      earlyExitAllowed: market ? market.earlyExitAllowed : null,
      earlyExitFeePercentOfNetCloseout: market ? wadPercent(market.earlyExitFee) : null,
      collateralBalance: amountText(row.position.collateralBalance, decimals),
    }
  })
  swapRows.sort((a, b) => b.entryTimestamp - a.entryTimestamp)
  const aave = []
  for (const token of tokens.values()) {
    const reserve = await readReserve(client, token.address)
    const debt = await client.readContract({
      address: debtTokenOf(reserve),
      abi: debtAbi,
      functionName: 'balanceOf',
      args: [account],
    })
    aave.push({
      asset: token.symbol || token.address,
      assetAddress: token.address,
      variableDebt: amountText(debt, token.decimals),
      variableBorrowAprPercent: wadPercent((reserve.currentVariableBorrowRate * WAD) / RAY),
    })
  }
  const accountData = asStruct(await client.readContract({
    address: ADDRESSES.pool,
    abi: poolAbi,
    functionName: 'getUserAccountData',
    args: [account],
  }), ['totalCollateralBase', 'totalDebtBase', 'availableBorrowsBase', 'currentLiquidationThreshold', 'ltv', 'healthFactor'])
  const health = accountData.healthFactor
  return {
    owner: account,
    healthFactor: health > 10n ** 30n ? null : formatUnits(health, 18),
    aave,
    swaps: swapRows,
  }
}

function sign(pi, { to, data, value, purpose }) {
  return pi.signRequest({
    chainId: CHAIN_ID,
    to,
    data,
    value: value == null ? '0' : String(value),
    purpose,
  })
}

function approveData(spender, amount) {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
}

async function allowance(client, token, owner, spender) {
  return client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
}

async function ensureErc20Approval(client, pi, { token, symbol, decimals, owner, spender, amount, why, remainingAfter }) {
  const current = await allowance(client, token, owner, spender)
  if (current >= amount) return null
  if (sameAddress(token, ADDRESSES.usdt) && current > 0n) {
    return {
      step: 'approve-reset',
      remaining: ['approve', ...remainingAfter],
      purpose: `Reset the ${symbol} allowance to 0 before raising it. ${why}`,
      signRequest: sign(pi, {
        to: token,
        data: approveData(spender, 0n),
        purpose: `Reset the ${symbol} allowance to 0 so the next approval can raise it. ${why}`,
      }),
    }
  }
  return {
    step: 'approve',
    remaining: remainingAfter,
    purpose: `Approve ${amountText(amount, decimals)} ${symbol}. ${why}`,
    signRequest: sign(pi, {
      to: token,
      data: approveData(spender, amount),
      purpose: `Approve ${amountText(amount, decimals)} ${symbol}. ${why}`,
    }),
  }
}

async function freshQuote(client, marketId, notional, decimals) {
  const market = await readMarket(client, marketId)
  if (!market.exists || market.terminated || Number(market.rateType) !== 0) {
    throw new Error('market is not a live BUY_FIXED Kairos market')
  }
  const feeConfig = await client.readContract({
    address: ADDRESSES.admin,
    abi: adminAbi,
    functionName: 'getFeeConfig',
  })
  const quote = await quoteMarket(client, marketId, market, notional, feeRateOf(feeConfig), decimals)
  return { market, quote }
}

function rateBoundOf(swapRate, rateSlippageBps) {
  return swapRate + rateSlippageBps * 10n ** 14n
}

export async function nextTransaction(pi, args) {
  const client = clientFor(args.rpcUrl)
  await assertDeployment(client)
  const owner = getAddress(pi.preferredKeyGenAddress())
  const action = String(args.action || '').toLowerCase()
  const rateSlip = bps(args.rateSlippageBps, DEFAULT_RATE_SLIPPAGE_BPS)
  if (action === 'open' || action === 'lock') {
    if (!isBytes32(args.marketId)) throw new Error('marketId must be the bytes32 from rates')
    const market = await readMarket(client, args.marketId)
    const token = await borrowAsset(client, market.swapToken)
    const notional = parseUnits(String(args.notional), token.decimals)
    if (notional <= 0n) throw new Error('notional must be greater than 0')
    const { quote } = await freshQuote(client, args.marketId, notional, token.decimals)
    const bound = rateBoundOf(quote.swapRate, rateSlip)
    const maxTotalIn = args.maxCost == null || args.maxCost === ''
      ? quote.maxTotalIn
      : parseUnits(String(args.maxCost), token.decimals)
    const summary = `${token.symbol} for ${quote.termDays} days. All-in borrow APR ${quote.allInBorrowAprPercent}% (fixed swap ${quote.fixedSwapAprPercent}% plus protocol fee ${quote.protocolFeeAprPercent}%). Protocol fee ${quote.protocolFeeAmount} ${token.symbol}. Early-exit fee ${quote.earlyExitFeePercentOfNetCloseout}% of the net closeout${quote.earlyExitAllowed ? '' : ', and early exit is not allowed'}.`
    if (action === 'lock') {
      const why = `This pays the Kairos swap that locks an existing Aave ${token.symbol} borrow. It does not open a new loan. ${summary}`
      const approval = await ensureErc20Approval(client, pi, {
        token: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        owner,
        spender: ADDRESSES.swapStore,
        amount: maxTotalIn,
        why,
        remainingAfter: ['lock'],
      })
      if (approval) return approval
      const data = encodeFunctionData({
        abi: coreAbi,
        functionName: 'buySwap',
        args: [args.marketId, notional, owner, bound, 0n, maxTotalIn],
      })
      const purpose = `Lock the rate on an existing Aave ${token.symbol} borrow of ${amountText(notional, token.decimals)} ${token.symbol}. ${summary} The swap may pull up to ${amountText(maxTotalIn, token.decimals)} ${token.symbol}.`
      return {
        step: 'lock',
        remaining: [],
        purpose,
        signRequest: sign(pi, { to: ADDRESSES.swapStore, data, purpose }),
      }
    }
    const collateral = await collateralAsset(client, args.collateralAsset)
    const collateralAmount = collateral
      ? parseUnits(args.collateralAmount == null || args.collateralAmount === '' ? '0' : String(args.collateralAmount), collateral.decimals)
      : 0n
    if (collateralAmount < 0n) throw new Error('collateralAmount must be zero or greater')
    if (collateral && collateralAmount > 0n && sameAddress(collateral.address, token.address)) {
      throw new Error('collateral cannot be the asset being borrowed')
    }
    const borrowAmount = args.borrowAmount == null || args.borrowAmount === ''
      ? notional
      : parseUnits(String(args.borrowAmount), token.decimals)
    if (borrowAmount <= 0n) throw new Error('borrowAmount must be greater than 0')
    const minHealth = parseUnits(args.minHealthFactor == null || args.minHealthFactor === '' ? DEFAULT_MIN_HEALTH : String(args.minHealthFactor), 18)
    const reserve = await readReserve(client, token.address)
    const debtToken = debtTokenOf(reserve)
    const delegated = await client.readContract({
      address: debtToken,
      abi: debtAbi,
      functionName: 'borrowAllowance',
      args: [owner, ADDRESSES.router],
    })
    const collateralText = !collateral || collateralAmount === 0n
      ? 'No new collateral. The borrow uses collateral already on Aave.'
      : `Collateral ${amountText(collateralAmount, collateral.decimals)} ${collateral.symbol}.`
    const why = `This opens a fixed-rate Aave borrow. ${collateralText} ${summary}`
    if (collateral && collateralAmount > 0n && !collateral.native) {
      const approval = await ensureErc20Approval(client, pi, {
        token: collateral.address,
        symbol: collateral.symbol,
        decimals: collateral.decimals,
        owner,
        spender: ADDRESSES.router,
        amount: collateralAmount,
        why,
        remainingAfter: delegated >= borrowAmount ? ['open'] : ['approve-delegation', 'open'],
      })
      if (approval) return approval
    }
    if (delegated < borrowAmount) {
      const purpose = `Let the Kairos router borrow ${amountText(borrowAmount, token.decimals)} ${token.symbol} on Aave in the KeyGen's name. ${why}`
      return {
        step: 'approve-delegation',
        remaining: ['open'],
        purpose,
        signRequest: sign(pi, {
          to: debtToken,
          data: encodeFunctionData({
            abi: debtAbi,
            functionName: 'approveDelegation',
            args: [ADDRESSES.router, borrowAmount],
          }),
          purpose,
        }),
      }
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(args.deadlineSeconds || 3600))
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: 'openFixedRateLoan',
      args: [
        {
          collateralAsset: collateral ? collateral.address : '0x0000000000000000000000000000000000000000',
          collateralAmount,
          borrowAsset: token.address,
          borrowAmount,
          marketId: args.marketId,
          notional,
          rateBound: bound,
          maxTotalIn,
          minHealthFactor: minHealth,
          deadline,
        },
        { deadline: 0n, signature: '0x' },
        { kind: 0, nonce: 0n, deadline: 0n, signature: '0x' },
      ],
    })
    const purpose = `Open a fixed-rate Aave borrow of ${amountText(borrowAmount, token.decimals)} ${token.symbol}, notional ${amountText(notional, token.decimals)}. ${collateralText} Minimum health factor ${args.minHealthFactor || DEFAULT_MIN_HEALTH}. ${summary} The swap may pull up to ${amountText(maxTotalIn, token.decimals)} ${token.symbol} from the borrowed amount.`
    return {
      step: 'open',
      remaining: [],
      purpose,
      signRequest: sign(pi, {
        to: ADDRESSES.router,
        data,
        value: collateral && collateral.native ? collateralAmount : 0n,
        purpose,
      }),
    }
  }
  if (action === 'repay') {
    const token = await borrowAsset(client, args.asset)
    const reserve = await readReserve(client, token.address)
    const debt = await client.readContract({
      address: debtTokenOf(reserve),
      abi: debtAbi,
      functionName: 'balanceOf',
      args: [owner],
    })
    if (debt === 0n) throw new Error(`no variable ${token.symbol} debt to repay`)
    const amount = String(args.amount || '').toLowerCase() === 'max' || args.amount == null || args.amount === ''
      ? debt + debt / 100n + 1n
      : parseUnits(String(args.amount), token.decimals)
    if (amount <= 0n) throw new Error('amount must be greater than 0')
    const why = `This repays Aave variable ${token.symbol} debt. It does not close the Kairos swap.`
    const approval = await ensureErc20Approval(client, pi, {
      token: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      owner,
      spender: ADDRESSES.pool,
      amount,
      why,
      remainingAfter: ['repay'],
    })
    if (approval) return approval
    const purpose = `Repay up to ${amountText(amount > debt ? debt : amount, token.decimals)} ${token.symbol} of Aave variable debt. Current debt is ${amountText(debt, token.decimals)} ${token.symbol}. ${why}`
    return {
      step: 'repay',
      remaining: [],
      purpose,
      signRequest: sign(pi, {
        to: ADDRESSES.pool,
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: 'repay',
          args: [token.address, amount, 2n, owner],
        }),
        purpose,
      }),
    }
  }
  if (action === 'exit' || action === 'settle') {
    if (!isBytes32(args.swapId)) throw new Error('swapId must be the bytes32 from positions')
    const position = await readPosition(client, args.swapId)
    if (position.entryTimestamp === 0n) throw new Error('swap not found')
    if (position.settled) throw new Error('swap is already settled')
    if (!sameAddress(position.userAddress, owner)) throw new Error('swap is not owned by the preferred KeyGen')
    const market = await readMarket(client, position.marketId)
    const token = await borrowAsset(client, market.swapToken)
    const now = BigInt((await client.getBlock()).timestamp)
    const expiry = position.entryTimestamp + BigInt(market.swapTerm)
    const expired = now >= expiry
    if (action === 'settle') {
      if (!expired) throw new Error('swap has not expired. Use action exit.')
      const purpose = `Settle Kairos swap ${args.swapId} for ${amountText(position.notionalAmount, token.decimals)} ${token.symbol} after its ${Number(market.swapTerm) / 86400} day term. Settlement pays the net of the fixed and floating legs. Early-exit fee does not apply.`
      return {
        step: 'settle',
        remaining: [],
        purpose,
        signRequest: sign(pi, {
          to: ADDRESSES.swapStore,
          data: encodeFunctionData({ abi: coreAbi, functionName: 'makePayment', args: [[args.swapId]] }),
          purpose,
        }),
      }
    }
    if (expired) throw new Error('swap has expired. Use action settle.')
    if (!market.earlyExitAllowed) throw new Error('this market does not allow early exit')
    const net = asStruct(await client.readContract({
      address: ADDRESSES.swapStore,
      abi: coreAbi,
      functionName: 'getSwapNetAmount',
      args: [args.swapId],
    }), ['netAmount', 'netRecipient'])
    const slip = bps(args.slippageBps, DEFAULT_EXIT_SLIPPAGE_BPS)
    const buyerReceives = Number(net.netRecipient) === 1
    const minExit = buyerReceives ? (net.netAmount * (10_000n - slip)) / 10_000n : 0n
    const netText = `${buyerReceives ? 'buyer receives' : 'pool receives'} ${amountText(net.netAmount, token.decimals)} ${token.symbol}`
    const floorText = buyerReceives
      ? `Minimum the buyer must receive is ${amountText(minExit, token.decimals)} ${token.symbol} (${slip.toString()} bps under the quoted net).`
      : 'The closeout pays the pool, so the slippage floor on tokens returned is off.'
    const purpose = `Exit Kairos swap ${args.swapId} early. ${amountText(position.notionalAmount, token.decimals)} ${token.symbol}, ${Number(market.swapTerm) / 86400} day term. Early-exit fee ${wadPercent(market.earlyExitFee)}% of the net closeout. Quoted net: ${netText}. ${floorText}`
    return {
      step: 'exit',
      remaining: [],
      purpose,
      signRequest: sign(pi, {
        to: ADDRESSES.swapStore,
        data: encodeFunctionData({
          abi: coreAbi,
          functionName: 'exitSwapEarly',
          args: [[{ swapId: args.swapId, minExitAmount: minExit }], owner],
        }),
        purpose,
      }),
    }
  }
  throw new Error('action must be open, lock, repay, exit, or settle')
}

function toolError(err) {
  const message = err && err.shortMessage ? err.shortMessage : err && err.message ? err.message : String(err)
  throw new Error(message)
}

export default function kairosFixedRateBorrow(pi) {
  pi.registerTool({
    name: 'rates',
    description: 'Quote Kairos fixed-rate USDC or USDT borrows on Aave V3 Ethereum for every live term. Includes fees and the early-exit penalty. notional defaults to 10000 tokens.',
    parameters: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'USDC, USDT, or the token address' },
        notional: { type: 'string', description: 'Borrow size in tokens. Default 10000.' },
      },
      required: ['asset'],
    },
    async execute(args) {
      try {
        return await readRates({ ...(args || {}), rpcUrl: nodeEthereumRpc(pi) })
      } catch (err) {
        toolError(err)
      }
    },
  })

  pi.registerTool({
    name: 'positions',
    description: 'List the preferred KeyGen Aave variable USDC and USDT debt beside its Kairos swaps on Ethereum.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute() {
      try {
        return await readPositions({ rpcUrl: nodeEthereumRpc(pi), owner: pi.preferredKeyGenAddress() })
      } catch (err) {
        toolError(err)
      }
    },
  })

  pi.registerTool({
    name: 'transact',
    description: 'Return the next Ethereum sign request for open, lock, repay, exit, or settle. Call again with the same arguments after the group signs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'open, lock, repay, exit, or settle' },
        marketId: { type: 'string', description: 'bytes32 from rates. Required for open and lock.' },
        notional: { type: 'string', description: 'Swap notional in borrow-asset tokens. Required for open and lock.' },
        borrowAmount: { type: 'string', description: 'Aave debt to open. Defaults to notional.' },
        collateralAsset: { type: 'string', description: 'ETH, WETH, wstETH, WBTC, or cbBTC. Omit to use collateral already on Aave.' },
        collateralAmount: { type: 'string', description: 'Collateral amount in tokens. 0 uses collateral already on Aave.' },
        minHealthFactor: { type: 'string', description: 'Minimum Aave health factor after open. Default 1.5.' },
        asset: { type: 'string', description: 'USDC or USDT. Required for repay.' },
        amount: { type: 'string', description: 'Repay amount in tokens, or max.' },
        swapId: { type: 'string', description: 'bytes32 from positions. Required for exit and settle.' },
        slippageBps: { type: 'string', description: 'Early-exit slippage in bps. Default 100.' },
        rateSlippageBps: { type: 'string', description: 'APR basis points added to the fixed-rate ceiling. Default 50.' },
        maxCost: { type: 'string', description: 'Optional cap, in borrow-asset tokens, on what the swap may pull.' },
        deadlineSeconds: { type: 'string', description: 'Open deadline from now, in seconds. Default 3600.' },
      },
      required: ['action'],
    },
    async execute(args) {
      try {
        const input = { ...(args || {}) }
        delete input.rpcUrl
        return await nextTransaction(pi, { ...input, rpcUrl: nodeEthereumRpc(pi) })
      } catch (err) {
        toolError(err)
      }
    },
  })
}
