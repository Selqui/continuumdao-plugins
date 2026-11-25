/*
 * trade-bot-hyperliquid-perp
 *
 * One tool, perp_trade_decision. The caller passes a Hyperliquid market name.
 * A contract address is rejected. The name does not have to be a saved node asset.
 * Analysis settings are passed in. This file does not read trade-desk.yaml.
 * It never signs and never posts a multi-sign request.
 */

const CHAIN_ID = 999

const ANALYSIS_TYPES = [
  'trend_structure',
  'elliott_waves',
  'key_levels',
  'key_level_fibonacci',
  'divergence',
  'range_volatility',
  'bollinger_bands',
  'donchian_breakout',
  'supertrend',
  'ichimoku',
  'z_score',
  'moving_averages',
  'chart_patterns',
  'momentum',
  'candlestick_patterns',
]

const ANALYSIS_LOAD = {
  trend_structure: ['chart/analysis/analyze-tools.js', 'analyzeTrendStructure', 'analyze_trend_structure'],
  elliott_waves: ['chart/analysis/elliott-waves-analyze-tools.js', 'analyzeElliottWavesTool', 'analyze_elliott_waves'],
  key_levels: ['chart/analysis/analyze-tools.js', 'analyzeKeyLevels', 'analyze_key_levels'],
  key_level_fibonacci: ['chart/analysis/analyze-tools.js', 'analyzeKeyLevelFibonacci', 'analyze_key_level_fibonacci'],
  divergence: ['chart/analysis/divergence-analyze-tools.js', 'analyzeDivergence', 'analyze_divergence'],
  range_volatility: ['chart/analysis/analyze-tools.js', 'analyzeRangeVolatility', 'analyze_range_volatility'],
  bollinger_bands: ['chart/analysis/bollinger-analyze-tools.js', 'analyzeBollingerBands', 'analyze_bollinger_bands'],
  donchian_breakout: ['chart/analysis/donchian-analyze-tools.js', 'analyzeDonchianBreakout', 'analyze_donchian_breakout'],
  supertrend: ['chart/analysis/supertrend-analyze-tools.js', 'analyzeSupertrend', 'analyze_supertrend'],
  ichimoku: ['chart/analysis/ichimoku-analyze-tools.js', 'analyzeIchimoku', 'analyze_ichimoku'],
  z_score: ['chart/analysis/z-score-analyze-tools.js', 'analyzeZScore', 'analyze_z_score'],
  moving_averages: ['chart/analysis/moving-averages-analyze-tools.js', 'analyzeMovingAverages', 'analyze_moving_averages'],
  chart_patterns: ['chart/analysis/chart-patterns-tools.js', 'analyzeChartPatterns', 'analyze_chart_patterns'],
  momentum: ['chart/analysis/analyze-tools.js', 'analyzeMomentum', 'analyze_momentum'],
  candlestick_patterns: ['chart/analysis/candlestick-patterns-tools.js', 'analyzeCandlestickPatterns', 'analyze_candlestick_patterns'],
}

const INTERVAL_HOURS = {
  '1m': 1 / 60,
  '3m': 3 / 60,
  '5m': 5 / 60,
  '15m': 15 / 60,
  '30m': 0.5,
  '1h': 1,
  '2h': 2,
  '4h': 4,
  '8h': 8,
  '12h': 12,
  '1d': 24,
  '3d': 72,
  '1w': 168,
  '1M': 720,
}

const loaders = new Map()

function num(value) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : Number(value)
  return Number.isFinite(n) ? n : null
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim())
}

function asBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

export const DEFAULT_MIN_CONFIDENCE_CANDLES = 0.8

function confidenceInRange(value) {
  const n = num(value)
  if (n == null || n < 0 || n > 1) return null
  return n
}

export function resolveMinConfidenceCandles(settings) {
  const fromSettings = settings && confidenceInRange(settings.minConfidenceCandles)
  if (fromSettings != null) return fromSettings
  return DEFAULT_MIN_CONFIDENCE_CANDLES
}

function settingsForAnalysis(analysisType, settings, minConfidenceCandles) {
  const next = settings && typeof settings === 'object' ? { ...settings } : {}
  delete next.minConfidenceCandles
  if (analysisType === 'candlestick_patterns') {
    next.minConfidence = minConfidenceCandles
  }
  return next
}

function roundTo(value, decimals) {
  const places = Number.isInteger(decimals) && decimals >= 0 ? decimals : 6
  const factor = 10 ** places
  return (Math.round(value * factor) / factor).toFixed(places)
}

function lookbackDays(interval, candleCount) {
  const hours = INTERVAL_HOURS[interval] || 4
  return Math.max(1, Math.ceil((candleCount * hours) / 24) + 1)
}

function candleRows(candles) {
  return candles.map((bar) => ({
    timestampMs: num(bar.timestampMs ?? bar.t ?? bar.time),
    open: num(bar.open ?? bar.o),
    high: num(bar.high ?? bar.h),
    low: num(bar.low ?? bar.l),
    close: num(bar.close ?? bar.c),
  })).filter((bar) => bar.close != null && bar.high != null && bar.low != null)
}

function unrecognizedKeys(reason) {
  const text = String(reason || '')
  if (!/unrecognized key/i.test(text)) return []
  return [...text.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)].map((match) => match[1])
}

async function loadAnalysis(pi, analysisType) {
  if (loaders.has(analysisType)) return loaders.get(analysisType)
  const [specifier, exportName, toolName] = ANALYSIS_LOAD[analysisType]
  const mod = await pi.importMarket(specifier)
  const fn = mod[exportName]
  if (typeof fn !== 'function') {
    throw new Error(`Market module ${specifier} has no ${exportName}.`)
  }
  const loaded = { fn, toolName }
  loaders.set(analysisType, loaded)
  return loaded
}

async function runAnalysis(pi, ideas, analysisType, candles, settings, minConfidenceCandles) {
  const loaded = await loadAnalysis(pi, analysisType)
  const rows = candleRows(candles)
  const input = {
    toolResult: { ohlcv: { candles } },
    rows,
    allowRowsOnly: true,
    mergeLive: false,
    ...settingsForAnalysis(analysisType, settings, minConfidenceCandles),
  }
  let result = await loaded.fn(input)
  for (let attempt = 0; attempt < 8 && result && result.ok === false; attempt += 1) {
    const keys = unrecognizedKeys(result.reason)
    if (keys.length === 0) break
    for (const key of keys) delete input[key]
    result = await loaded.fn(input)
  }
  if (!result || result.ok === false) {
    return { error: result && result.reason ? result.reason : 'Analysis failed.' }
  }
  const analysis = result.data && result.data.analysis ? result.data.analysis : result.data
  const idea = ideas.tradeIdeaFromAnalyzeOutput(loaded.toolName, analysis, {
    symbol: analysisType,
    protocolId: 'hyperliquid',
  })
  const pattern = candlestickPatternName(analysis)
  if (pattern && idea && typeof idea === 'object') idea.candlestickPattern = pattern
  return { idea, analysis }
}

function candlestickPatternName(analysis) {
  const setup = analysis && analysis.candlestickTradeSetup
  if (!setup || setup.patternId == null || setup.patternId === 'none') return null
  const name = typeof setup.patternName === 'string' ? setup.patternName.trim() : ''
  return name || null
}

function isClearSide(idea) {
  return Boolean(idea) && idea.status === 'clear' && (idea.side === 'long' || idea.side === 'short')
}

function levelPrice(level) {
  const px = level && num(level.price)
  return px != null && px > 0 ? px : null
}

function ideaEntryPrice(idea) {
  return levelPrice(idea && idea.entry)
}

export function barIncludesPrice(bar, price) {
  if (!bar || !(price > 0) || bar.low == null || bar.high == null) return false
  return bar.low <= price && price <= bar.high
}

const CLEAR_ENTRY_MISSED = 'Clear idea, entry not inside the bar.'
const SKIPPED_REASON_LIMIT = 5

export function skippedSummary(bars, analysisErrors, analysisError, reasonCounts) {
  const reasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, SKIPPED_REASON_LIMIT)
    .map(([reason, count]) => ({ count, reason }))
  const skipped = { bars, analysisErrors, reasons }
  if (analysisError) skipped.analysisError = analysisError
  return skipped
}

export function protectiveLevels(side, entry, idea) {
  const invalidation = levelPrice(idea && idea.invalidation)
  const target = levelPrice(idea && idea.target)
  if (side === 'long') {
    return {
      invalidation: invalidation != null && invalidation < entry ? invalidation : null,
      target: target != null && target > entry ? target : null,
    }
  }
  if (side === 'short') {
    return {
      invalidation: invalidation != null && invalidation > entry ? invalidation : null,
      target: target != null && target < entry ? target : null,
    }
  }
  return { invalidation: null, target: null }
}

// A bar that trades through the open idea's invalidation, target, or liquidation
// fills at that level, including when the print goes past it. If more than one
// is inside the bar, the level closer to the open is first. An equal distance
// fills at the worse price.
export function levelExitPrice(side, levels, bar) {
  if (!levels || !bar || (side !== 'long' && side !== 'short')) return null
  const open = bar.open != null ? bar.open : bar.close
  if (open == null) return null
  const hits = []
  const stop = levels.invalidation
  const target = levels.target
  const liquidation = levels.liquidation
  if (side === 'long') {
    if (stop != null && bar.low != null && bar.low <= stop) hits.push(stop)
    if (target != null && bar.high != null && bar.high >= target) hits.push(target)
    if (liquidation != null && bar.low != null && bar.low <= liquidation) hits.push(liquidation)
  } else {
    if (stop != null && bar.high != null && bar.high >= stop) hits.push(stop)
    if (target != null && bar.low != null && bar.low <= target) hits.push(target)
    if (liquidation != null && bar.high != null && bar.high >= liquidation) hits.push(liquidation)
  }
  let best = null
  let bestDist = Infinity
  for (const px of hits) {
    const dist = Math.abs(open - px)
    const adverse = best != null && dist === bestDist && (side === 'long' ? px < best : px > best)
    if (best == null || dist < bestDist || adverse) {
      best = px
      bestDist = dist
    }
  }
  return best
}

export function exitReason(levels, exitPrice) {
  if (!levels || !(exitPrice > 0)) return null
  for (const name of ['invalidation', 'target', 'liquidation']) {
    const px = levels[name]
    if (px == null || !(px > 0)) continue
    const tol = 1e-8 * Math.max(1, Math.abs(px))
    if (Math.abs(px - exitPrice) <= tol) return name
  }
  return null
}

// Hyperliquid: opening margin is notional / leverage, and collateral left over
// must cover 10% of notional (transfer_margin_required = max(initial margin, 0.1 * notional)).
// That caps notional at account * leverage / (1 + 0.1 * leverage). `percent` takes that fraction.
const HYPERLIQUID_COLLATERAL_RESERVE = 0.1

export function tradableNotional(accountValue, percent, leverage) {
  if (!(accountValue > 0) || !(leverage >= 1) || !(percent > 0)) return 0
  const maxNotional = accountValue * leverage / (1 + HYPERLIQUID_COLLATERAL_RESERVE * leverage)
  return maxNotional * (percent / 100)
}

export function liquidationPrice(side, entry, leverage) {
  if (!(entry > 0) || !(leverage >= 1)) return null
  if (side === 'long') return entry * (1 - 1 / leverage)
  if (side === 'short') return entry * (1 + 1 / leverage)
  return null
}

export function parseLeverageLabel(label) {
  const match = String(label || '').match(/(\d+(?:\.\d+)?)x/i)
  const leverage = match ? Number(match[1]) : null
  return leverage != null && leverage >= 1 ? leverage : null
}

export function spotTopUpNotice(market, leverage) {
  return `Send USDC to the KeyGen spot balance before a live trade. Leverage on ${market} is ${leverage}x. Hyperliquid will not change that leverage until spot USDC has arrived. After the USDC is on spot, ask the agent to change it.`
}

export function closePaperPosition(book, exitPrice) {
  const pnl = book.position === 'long'
    ? (exitPrice - book.entry) * book.qty
    : (book.entry - exitPrice) * book.qty
  const margin = book.margin != null ? book.margin : book.qty * book.entry
  return {
    usdc: book.usdc + margin + pnl,
    qty: 0,
    entry: 0,
    margin: 0,
    position: null,
    levels: null,
    openedAt: -1,
  }
}

function confirms(idea, side) {
  return isClearSide(idea) && idea.side === side
}

function orderPayload(action, coin, side, limitPx, size, szDecimals) {
  const limitPxHuman = roundTo(limitPx, 6)
  const szHuman = roundTo(size, szDecimals)
  return {
    payload: {
      kind: 'hyperliquid-perp',
      action,
      coin,
      side,
      limitPxHuman,
      szHuman,
      reduceOnly: action === 'close',
    },
    coin,
    side,
    limitPxHuman,
    szHuman,
  }
}

export default async function plugin(pi) {
  const hl = await pi.importDefi('protocols/evm/hyperliquid')
  const ideas = await pi.importMarket('trade-ideas')

  pi.registerTool({
    name: 'perp_trade_decision',
    description: 'Decide a Hyperliquid perpetual from a market name and one technical-analysis type. Candlestick and the other types run inside this tool, including the candlestick switch. Returns an unsigned open or close payload, a backtest with its trade ledger and skip summary, or does nothing. Does not draw a chart.',
    parameters: {
      asset: { type: 'string', description: 'Hyperliquid market name, such as BTC. A contract address is rejected.' },
      interval: { type: 'string', description: 'Candle interval, such as 4h.' },
      candleCount: { type: 'number', description: 'Number of candles to keep.' },
      analysisType: { type: 'string', description: 'Library analysis id, underscores, no hyphens.' },
      mode: { type: 'string', description: 'dry-run, backtest, or live.' },
      momentum: { type: 'boolean', description: 'When true, an open requires a clear momentum idea on the same side. A close does not.' },
      candlestick: { type: 'boolean', description: 'When true, an open requires a clear candlestick idea on the same side. A close does not.' },
      analysisSettings: { type: 'object', description: 'Periods and entry settings for the named type. Passed in by the caller. minConfidenceCandles from the candlestick desk block is the hit gate for candlestick_patterns and for the candlestick switch. Default 0.8 when that line is absent.' },
      lookbackDays: { type: 'number' },
      percent: { type: 'number' },
      initialBalanceUsdc: { type: 'string' },
      maxSeriesPoints: { type: 'number' },
      chainId: { type: 'number' },
    },
    async execute(args) {
      const asset = String(args.asset || '').trim()
      if (!asset) return { error: 'Pass a Hyperliquid market name, such as BTC.' }
      if (isAddress(asset)) {
        return { error: 'A contract address is rejected. Pass the Hyperliquid market name, such as BTC.' }
      }
      const interval = String(args.interval || '4h')
      const candleCount = Math.floor(Number(args.candleCount))
      if (!Number.isFinite(candleCount) || candleCount < 2) {
        return { error: 'candleCount must be a number of candles.' }
      }
      const analysisType = String(args.analysisType || '')
      if (!ANALYSIS_TYPES.includes(analysisType)) {
        return { error: `analysisType must be one of: ${ANALYSIS_TYPES.join(', ')}.` }
      }
      const mode = String(args.mode || 'dry-run')
      if (mode !== 'dry-run' && mode !== 'backtest' && mode !== 'live') {
        return { error: 'mode must be dry-run, backtest, or live.' }
      }
      const settings = args.analysisSettings && typeof args.analysisSettings === 'object' ? { ...args.analysisSettings } : {}
      const minConfidenceCandles = resolveMinConfidenceCandles(settings)
      const chainId = Number(args.chainId) > 0 ? Number(args.chainId) : CHAIN_ID
      const percent = Number(args.percent) > 0 ? Number(args.percent) : 50
      const momentumOn = asBool(args.momentum)
      const candlestickOn = asBool(args.candlestick)

      let resolved
      try {
        resolved = await hl.hyperliquidResolvePerpMarket({ chainId, coin: asset })
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
      const market = resolved.name || resolved.coin
      const days = Number(args.lookbackDays) > 0 ? Number(args.lookbackDays) : lookbackDays(interval, candleCount)
      const fetched = await hl.hyperliquidFetchOhlcvSummary({
        chainId,
        coin: market,
        interval,
        dex: resolved.dex,
        lookbackDays: days,
      })
      const candles = (fetched.ohlcv && fetched.ohlcv.candles ? fetched.ohlcv.candles : []).slice(-candleCount)
      if (candles.length < candleCount) {
        return { error: `Hyperliquid returned ${candles.length} candles; candleCount is ${candleCount}.` }
      }

      const leverageRead = await readKeyGenLeverage(pi, hl, chainId, market)
      if (leverageRead.error) return { error: leverageRead.error }

      if (mode === 'backtest') {
        return backtest({
          pi,
          ideas,
          analysisType,
          candles,
          settings,
          minConfidenceCandles,
          momentumOn,
          candlestickOn,
          market,
          interval,
          candleCount,
          percent,
          leverage: leverageRead.leverage,
          szDecimals: resolved.szDecimals,
          initialBalanceUsdc: args.initialBalanceUsdc || '1000',
          maxSeriesPoints: Number(args.maxSeriesPoints) > 0 ? Math.floor(Number(args.maxSeriesPoints)) : 400,
        })
      }

      const primary = await runAnalysis(pi, ideas, analysisType, candles, settings, minConfidenceCandles)
      if (primary.error) return { error: primary.error }
      const book = await readBook(pi, hl, chainId, market, mode)
      if (book.error) return { error: book.error }
      const decision = await decide({
        pi,
        ideas,
        primary: primary.idea,
        analysisType,
        candles,
        settings,
        minConfidenceCandles,
        momentumOn,
        candlestickOn,
        position: book.position,
      })
      if (decision.error) return { error: decision.error }
      const last = candleRows(candles).at(-1)
      const price = decision.idea && decision.idea.entry && decision.idea.entry.price
        ? decision.idea.entry.price
        : last && last.close
      const needsSpot = mode === 'live' && !(book.spot > 0)
      const userNotice = needsSpot ? spotTopUpNotice(market, leverageRead.leverage) : null
      let liveDecision = decision.decision
      let liveReason = decision.reason
      let payload = {}
      if (needsSpot && decision.decision === 'open') {
        liveDecision = 'nothing'
        liveReason = userNotice
      } else if ((decision.decision === 'open' || decision.decision === 'close') && price) {
        const collateral = mode === 'live' ? leverageRead.accountValue : book.paperUsdc
        const notional = tradableNotional(collateral, percent, leverageRead.leverage)
        if (mode === 'live' && decision.decision === 'open' && !(collateral > 0)) {
          return { error: 'The KeyGen perp account has no collateral for this order.' }
        }
        if (mode === 'live' && decision.decision === 'open' && notional / leverageRead.leverage > collateral) {
          return { error: 'The KeyGen perp collateral is below the sized order.' }
        }
        const size = decision.decision === 'close' && book.positionSize
          ? book.positionSize
          : (price > 0 ? notional / price : 0)
        payload = orderPayload(decision.decision, market, decision.side, price, size, resolved.szDecimals)
      }
      return {
        mode,
        decision: liveDecision,
        reason: liveReason,
        market,
        candleCount: candles.length,
        analysisType,
        analysisSettings: settings,
        leverage: leverageRead.leverage,
        balanceRead: book.balanceRead,
        ...(mode === 'live' ? { spotUsdc: String(book.spot) } : {}),
        ...(userNotice ? { userNotice } : {}),
        side: decision.side || null,
        confidence: decision.idea ? decision.idea.confidence : null,
        position: book.position,
        ...payload,
      }
    },
  })
}

async function readKeyGenLeverage(pi, hl, chainId, market) {
  let address = ''
  try {
    address = pi.preferredKeyGenAddress()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const fetched = await hl.hyperliquidFetchOpenMarketContext({
    chainId,
    executorAddress: String(address).trim(),
    coin: market,
  })
  const context = fetched && fetched.context
  const label = context && context.activeAsset && context.activeAsset.leverageLabel
  const leverage = parseLeverageLabel(label)
  if (leverage == null) {
    return { error: 'Hyperliquid did not return leverage for this KeyGen and market.' }
  }
  const accountValue = num(context && context.account && context.account.accountValueUsd) || 0
  return { leverage, accountValue }
}

async function readBook(pi, hl, chainId, market, mode) {
  if (mode !== 'live') {
    return { position: null, paperUsdc: 1000, balanceRead: false }
  }
  let address = ''
  try {
    address = pi.preferredKeyGenAddress()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const balances = await hl.hyperliquidFetchUsdClassBalancesSummary({ chainId, executorAddress: address })
  const spot = num(balances.balances && balances.balances.spotUsdcAvailable) || 0
  const positions = await hl.hyperliquidFetchPositionsForExecutor({ chainId, executorAddress: address })
  const row = (positions.positions || []).find((item) => String(item.coin || '').toLowerCase() === market.toLowerCase())
  return {
    position: row ? (row.isLong ? 'long' : 'short') : null,
    positionSize: row && num(row.size) ? num(row.size) : 0,
    paperUsdc: spot,
    balanceRead: true,
    spot,
  }
}

async function confirmationIdea(input, analysisType) {
  if (input.analysisType === analysisType) return { idea: input.primary }
  return runAnalysis(
    input.pi,
    input.ideas,
    analysisType,
    input.candles,
    input.settings,
    input.minConfidenceCandles,
  )
}

async function decide(input) {
  const idea = input.primary
  if (!isClearSide(idea)) {
    return { decision: 'nothing', reason: 'No clear trade idea.', idea, side: null }
  }
  const side = idea.side
  if (!input.position && input.momentumOn) {
    const momentum = await confirmationIdea(input, 'momentum')
    if (momentum.error) return { error: momentum.error }
    if (!confirms(momentum.idea, side)) {
      return { decision: 'nothing', reason: 'Momentum is on and does not confirm the open.', idea, side }
    }
  }
  let confirmingPattern = null
  if (!input.position && input.candlestickOn) {
    const candles = await confirmationIdea(input, 'candlestick_patterns')
    if (candles.error) return { error: candles.error }
    if (!confirms(candles.idea, side)) {
      return { decision: 'nothing', reason: 'Candlestick is on and does not confirm the open.', idea, side }
    }
    confirmingPattern = candles.idea && candles.idea.candlestickPattern
  }
  const candlestickPattern = confirmingPattern || idea.candlestickPattern || null
  if (!input.position) {
    return { decision: 'open', reason: 'No open perpetual and a clear idea.', idea, side, candlestickPattern }
  }
  if (input.position === side) {
    return { decision: 'nothing', reason: 'The open perpetual is already in this direction.', idea, side }
  }
  return { decision: 'close', reason: 'The open perpetual is in the opposite direction.', idea, side, candlestickPattern }
}

async function backtest(input) {
  const initial = num(input.initialBalanceUsdc) || 1000
  const leverage = input.leverage >= 1 ? input.leverage : 1
  let usdc = initial
  let position = null
  let qty = 0
  let entry = 0
  let margin = 0
  let levels = null
  let openedAt = -1
  const balanceSeries = []
  const ledger = []
  let openFill = null
  let walked = 0
  let analysisErrors = 0
  let analysisError = ''
  const reasonCounts = new Map()
  const rows = candleRows(input.candles)
  const minBars = Math.min(40, Math.max(10, Math.floor(rows.length / 5)))
  function noteAnalysisError(reason) {
    analysisErrors += 1
    if (!analysisError) analysisError = String(reason || 'Analysis failed.')
  }
  function noteSkip(reason) {
    const text = String(reason || 'No clear trade idea.')
    reasonCounts.set(text, (reasonCounts.get(text) || 0) + 1)
  }
  function closeBook(exitPrice, exitTimeMs, reason, exitPattern, exitIndex) {
    const cash = usdc
    const posted = margin
    const closed = closePaperPosition({ usdc, qty, entry, margin, position, levels, openedAt }, exitPrice)
    const entryPattern = openFill && openFill.candlestickPattern
    ledger.push({
      status: 'closed',
      side: position,
      reason,
      entryPrice: Number(entry.toFixed(6)),
      exitPrice: Number(exitPrice.toFixed(6)),
      entryTimeMs: openFill ? openFill.entryTimeMs : null,
      exitTimeMs: exitTimeMs ?? null,
      barsHeld: exitIndex - openedAt,
      qty: Number(qty.toFixed(8)),
      margin: Number(posted.toFixed(6)),
      pnl: Number((closed.usdc - cash - posted).toFixed(6)),
      balanceUsdc: Number(closed.usdc.toFixed(6)),
      ...(entryPattern ? { candlestickPattern: entryPattern } : {}),
      ...(exitPattern ? { exitCandlestickPattern: exitPattern } : {}),
    })
    usdc = closed.usdc
    qty = closed.qty
    entry = closed.entry
    margin = closed.margin
    position = closed.position
    levels = closed.levels
    openedAt = closed.openedAt
    openFill = null
  }
  for (let i = minBars; i < input.candles.length; i += 1) {
    const slice = input.candles.slice(0, i + 1)
    const primary = await runAnalysis(
      input.pi,
      input.ideas,
      input.analysisType,
      slice,
      input.settings,
      input.minConfidenceCandles,
    )
    const bar = rows[i]
    const price = bar && bar.close
    const flatAtStart = !position
    walked += 1
    if (position && qty > 0 && i > openedAt) {
      const exitPrice = levelExitPrice(position, levels, bar)
      if (exitPrice != null) closeBook(exitPrice, bar && bar.timestampMs, exitReason(levels, exitPrice) || 'invalidation', null, i)
    }
    if (primary.error) {
      if (flatAtStart) noteAnalysisError(primary.error)
    } else if (price) {
      const decision = await decide({
        ...input,
        primary: primary.idea,
        candles: slice,
        position,
      })
      if (decision.error) {
        if (flatAtStart && !position) noteAnalysisError(decision.error)
      } else if (decision.decision === 'open' && !position) {
        const fill = ideaEntryPrice(decision.idea)
        if (barIncludesPrice(bar, fill)) {
          const notional = tradableNotional(usdc, input.percent, leverage)
          margin = leverage > 0 ? notional / leverage : 0
          qty = notional / fill
          usdc -= margin
          entry = fill
          position = decision.side
          levels = protectiveLevels(decision.side, fill, decision.idea)
          levels.liquidation = liquidationPrice(decision.side, fill, leverage)
          openedAt = i
          openFill = {
            entryTimeMs: bar.timestampMs ?? null,
            candlestickPattern: decision.candlestickPattern || null,
          }
        } else if (flatAtStart) {
          noteSkip(CLEAR_ENTRY_MISSED)
        }
      } else if (decision.decision === 'close' && position && qty > 0) {
        closeBook(price, bar && bar.timestampMs, 'signal', decision.candlestickPattern, i)
      } else if (flatAtStart && !position) {
        noteSkip((decision.idea && decision.idea.unclearReason) || decision.reason)
      }
    }
    const mark = price || entry
    const pnl = position && qty && mark
      ? (position === 'long' ? (mark - entry) * qty : (entry - mark) * qty)
      : 0
    const equity = usdc + (position && qty ? margin + pnl : 0)
    balanceSeries.push(Number(equity.toFixed(6)))
  }
  if (position && qty > 0 && openFill) {
    const last = rows[rows.length - 1]
    const mark = last && last.close
    const openPnl = mark
      ? (position === 'long' ? (mark - entry) * qty : (entry - mark) * qty)
      : 0
    ledger.push({
      status: 'open',
      side: position,
      reason: null,
      entryPrice: Number(entry.toFixed(6)),
      exitPrice: null,
      entryTimeMs: openFill.entryTimeMs,
      exitTimeMs: null,
      barsHeld: rows.length - 1 - openedAt,
      qty: Number(qty.toFixed(8)),
      margin: Number(margin.toFixed(6)),
      pnl: Number(openPnl.toFixed(6)),
      balanceUsdc: Number(usdc.toFixed(6)),
      ...(openFill.candlestickPattern ? { candlestickPattern: openFill.candlestickPattern } : {}),
    })
  }
  const capped = downsample(balanceSeries, input.maxSeriesPoints)
  const finalBalance = capped.length ? capped[capped.length - 1] : initial
  return {
    mode: 'backtest',
    market: input.market,
    candleCount: input.candleCount,
    analysisType: input.analysisType,
    analysisSettings: input.settings,
    leverage,
    balanceRead: false,
    initialBalanceUsdc: String(input.initialBalanceUsdc || initial),
    ledger,
    skipped: skippedSummary(walked, analysisErrors, analysisError, reasonCounts),
    balanceSeries: capped,
    finalBalanceUsdc: String(finalBalance),
    finalBalanceRatioPct: initial > 0 ? Number(((finalBalance / initial) * 100).toFixed(4)) : null,
    pctProfit: initial > 0 ? Number((((finalBalance - initial) / initial) * 100).toFixed(4)) : null,
  }
}

function downsample(series, maxPoints) {
  if (series.length <= maxPoints) return series
  const step = Math.ceil(series.length / maxPoints)
  const out = []
  for (let i = 0; i < series.length; i += step) out.push(series[i])
  if (out[out.length - 1] !== series[series.length - 1]) out.push(series[series.length - 1])
  return out
}
