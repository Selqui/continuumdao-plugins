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
  if (
    analysisType === 'candlestick_patterns' &&
    idea &&
    idea.status === 'clear' &&
    (idea.side === 'long' || idea.side === 'short')
  ) {
    const patternId = analysis && analysis.candlestickTradeSetup && analysis.candlestickTradeSetup.patternId
    const stop = candlestickInvalidation(idea.side, rows, patternId)
    if (stop != null) {
      idea.invalidation = { price: stop, label: idea.side === 'long' ? 'Pattern low' : 'Pattern high' }
    }
  }
  return { idea, analysis }
}

function candlestickPatternName(analysis) {
  const setup = analysis && analysis.candlestickTradeSetup
  if (!setup || setup.patternId == null || setup.patternId === 'none') return null
  const name = typeof setup.patternName === 'string' ? setup.patternName.trim() : ''
  return name || null
}

const CANDLESTICK_PATTERN_BARS = {
  engulfing: 2,
  harami: 2,
  piercing: 2,
  dark_cloud_cover: 2,
  morning_star: 3,
  evening_star: 3,
  three_white_soldiers: 3,
  three_black_crows: 3,
}

export function candlestickInvalidation(side, rows, patternId) {
  if (side !== 'long' && side !== 'short') return null
  const span = CANDLESTICK_PATTERN_BARS[patternId] || 1
  const end = rows.length - 1
  const start = end - (span - 1)
  if (start < 0) return null
  const entry = rows[end] && rows[end].close
  if (!(entry > 0)) return null
  let extreme = side === 'long' ? Infinity : -Infinity
  for (let i = start; i <= end; i += 1) {
    const bar = rows[i]
    const px = bar && (side === 'long' ? bar.low : bar.high)
    if (!(px > 0)) return null
    extreme = side === 'long' ? Math.min(extreme, px) : Math.max(extreme, px)
  }
  if (side === 'long' && extreme < entry) return extreme
  if (side === 'short' && extreme > entry) return extreme
  return null
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

export const INSTANT_SETUP_NOTICE = 'Open Node => AI Agent => Cron. On the other nodes, set auto-accept-sign-request to Active and Instant. On this node, set auto-sign-and-broadcast to Active and Instant. You may miss trades if you rely on a person, or on AI actionable agreement and broadcasting, which can be slow.'

export function broadcastHookReady(report) {
  const jobs = report && report.signAndBroadcast && report.signAndBroadcast.jobs
  if (!Array.isArray(jobs)) return false
  return jobs.some((job) => job && job.name === 'auto-sign-and-broadcast' && job.set === true && job.active === true)
}

// report_instant_hooks, supplied by the host as pi.instantHooks().
// This node can hold one Instant job. Auto-accept belongs on the other nodes.
export function instantCronNotice(report) {
  if (broadcastHookReady(report)) return null
  return INSTANT_SETUP_NOTICE
}

function readInstantSetupNotice(pi) {
  try {
    if (!pi || typeof pi.instantHooks !== 'function') return INSTANT_SETUP_NOTICE
    return instantCronNotice(pi.instantHooks())
  } catch {
    return INSTANT_SETUP_NOTICE
  }
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

// Free cash still includes the 10% reserve against the open notional.
// Remaining collateral is what can be posted without spending that reserve.
export function availableCollateral(freeUsdc, qty, entry) {
  const reserve = qty > 0 && entry > 0 ? HYPERLIQUID_COLLATERAL_RESERVE * qty * entry : 0
  const available = freeUsdc - reserve
  return available > 0 ? available : 0
}

export function priceAlongTarget(entry, target, pct) {
  return entry + (target - entry) * (pct / 100)
}

export function closeReachedProgress(side, close, entry, target, pct) {
  if (side !== 'long' && side !== 'short') return false
  if (!(close > 0) || !(entry > 0) || !(target > 0)) return false
  if (side === 'long' && !(target > entry)) return false
  if (side === 'short' && !(target < entry)) return false
  const level = priceAlongTarget(entry, target, pct)
  return side === 'long' ? close >= level : close <= level
}

export function nextStopPrice(side, entry, target, offsetPct, currentStop, referenceClose) {
  if (side !== 'long' && side !== 'short') return null
  if (!(entry > 0) || !(target > 0) || !(referenceClose > 0)) return null
  const next = priceAlongTarget(entry, target, offsetPct)
  const tol = 1e-9 * Math.max(1, Math.abs(next))
  if (side === 'long') {
    if (!(next < referenceClose) || !(next < target)) return null
    if (currentStop != null && next <= currentStop + tol) return null
    return next
  }
  if (!(next > referenceClose) || !(next > target)) return null
  if (currentStop != null && next >= currentStop - tol) return null
  return next
}

// Set the stop back from the previous close by offsetPct of the entry-to-target range.
// Long: close − offset. Short: close + offset. Only a tighter stop is returned.
export function trailingStopFromClose(side, entry, target, offsetPct, currentStop, referenceClose) {
  if (side !== 'long' && side !== 'short') return null
  if (!(entry > 0) || !(target > 0) || !(referenceClose > 0) || !(offsetPct > 0)) return null
  const span = target - entry
  if (side === 'long' && !(span > 0)) return null
  if (side === 'short' && !(span < 0)) return null
  const next = referenceClose - (offsetPct / 100) * span
  const tol = 1e-9 * Math.max(1, Math.abs(next))
  if (side === 'long') {
    if (!(next < referenceClose) || !(next < target)) return null
    if (currentStop != null && next <= currentStop + tol) return null
    return next
  }
  if (!(next > referenceClose) || !(next > target)) return null
  if (currentStop != null && next >= currentStop - tol) return null
  return next
}

export function parseManagementPair(value, label) {
  if (value == null || value === false || value === '') return { rule: null }
  let first
  let second
  if (Array.isArray(value)) {
    first = value[0]
    second = value[1]
  } else if (typeof value === 'object') {
    first = value.progressPct ?? value.progress
    second = value.sizePct ?? value.offsetPct ?? value.amountPct
  } else {
    const parts = String(value).trim().replace(/%/g, ' ').split(/[\s,]+/).filter(Boolean)
    if (parts.length < 2) {
      return { error: `${label} needs two percents, such as 50 5.` }
    }
    first = parts[0]
    second = parts[1]
  }
  const progressPct = num(first)
  const sizePct = num(second)
  if (progressPct == null || sizePct == null) {
    return { error: `${label} needs two percents, such as 50 5.` }
  }
  if (!(progressPct > 0) || progressPct > 100) {
    return { error: `${label} progress percent must be greater than 0 and at most 100.` }
  }
  if (sizePct < 0 || sizePct > 100) {
    return { error: `${label} second percent must be from 0 to 100.` }
  }
  if (label === 'stop-to-entry') {
    if (sizePct >= progressPct) {
      return { error: 'stop-to-entry offset percent must be below the progress percent, so the new stop stays behind the trigger.' }
    }
  } else if (!(sizePct > 0)) {
    return { error: `${label} size percent must be greater than 0.` }
  }
  return { rule: { progressPct, sizePct } }
}

export function parseManagementRules(args) {
  const stopToEntry = parseManagementPair(args && args.stopToEntry, 'stop-to-entry')
  if (stopToEntry.error) return stopToEntry
  const addToPosition = parseManagementPair(args && args.addToPosition, 'add-to-position')
  if (addToPosition.error) return addToPosition
  const removeFromPosition = parseManagementPair(args && args.removeFromPosition, 'remove-from-position')
  if (removeFromPosition.error) return removeFromPosition
  const trailingStop = parseManagementPair(args && args.trailingStop, 'trailing-stop')
  if (trailingStop.error) return trailingStop
  return {
    rules: {
      stopToEntry: stopToEntry.rule,
      addToPosition: addToPosition.rule,
      removeFromPosition: removeFromPosition.rule,
      trailingStop: trailingStop.rule,
    },
  }
}

export function managementActive(rules) {
  return Boolean(rules && (rules.stopToEntry || rules.addToPosition || rules.removeFromPosition || rules.trailingStop))
}

// Previous close qualifies the rule. The fill price is where an add or remove trades.
// stop-to-entry, add, and remove are consumed once per position. The trailing stop
// updates on every later close that is still far enough toward the target.
// A stop only moves tighter. An open already through the stop does not add or remove.
export function planManagement(state) {
  const done = {
    stop: Boolean(state.done && state.done.stop),
    add: Boolean(state.done && state.done.add),
    remove: Boolean(state.done && state.done.remove),
  }
  const side = state.side
  const entry = state.entry
  const target = state.target
  const prevClose = state.prevClose
  const fill = state.fillPrice
  const rules = state.rules || {}
  let stop = state.stop != null ? state.stop : null
  let stopChange = null
  let trailChange = null
  let add = null
  let remove = null
  if (!(target > 0) || !(entry > 0) || !(prevClose > 0)) {
    return { stop, stopChange, trailChange, add, remove, done }
  }
  if (rules.stopToEntry && !done.stop && closeReachedProgress(side, prevClose, entry, target, rules.stopToEntry.progressPct)) {
    done.stop = true
    const next = nextStopPrice(side, entry, target, rules.stopToEntry.sizePct, stop, prevClose)
    if (next != null) {
      stop = next
      stopChange = next
    }
  }
  if (rules.trailingStop && closeReachedProgress(side, prevClose, entry, target, rules.trailingStop.progressPct)) {
    const next = trailingStopFromClose(side, entry, target, rules.trailingStop.sizePct, stop, prevClose)
    if (next != null) {
      stop = next
      trailChange = next
    }
  }
  const throughStop = stop != null && fill > 0 && (side === 'long' ? fill <= stop : fill >= stop)
  if (throughStop || !(fill > 0) || !(state.qty > 0)) {
    return { stop, stopChange, trailChange, add, remove, done }
  }
  if (rules.removeFromPosition && !done.remove && closeReachedProgress(side, prevClose, entry, target, rules.removeFromPosition.progressPct)) {
    done.remove = true
    const frac = rules.removeFromPosition.sizePct / 100
    const cutQty = state.qty * frac
    const cutMargin = state.margin * frac
    if (cutQty > 0 && cutMargin >= 0) {
      const pnl = side === 'long' ? (fill - entry) * cutQty : (entry - fill) * cutQty
      remove = { qty: cutQty, margin: cutMargin, pnl, price: fill, full: cutQty >= state.qty * (1 - 1e-9) }
    }
  }
  if (rules.addToPosition && !done.add && closeReachedProgress(side, prevClose, entry, target, rules.addToPosition.progressPct)) {
    done.add = true
    const qtyAfter = remove && remove.full ? 0 : state.qty - (remove ? remove.qty : 0)
    if (qtyAfter > 0) {
      const freed = remove && !remove.full ? remove.margin + remove.pnl : 0
      const cash = state.freeUsdc + freed
      const available = state.collateralIsWithdrawable
        ? (cash > 0 ? cash : 0)
        : availableCollateral(cash, qtyAfter, entry)
      const notional = tradableNotional(available, rules.addToPosition.sizePct, state.leverage)
      if (notional > 0) {
        add = { qty: notional / fill, margin: notional / state.leverage, price: fill }
      }
    }
  }
  return { stop, stopChange, trailChange, add, remove, done }
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
    description: 'Decide a Hyperliquid perpetual from a market name and one technical-analysis type. Candlestick and the other types run inside this tool, including the candlestick switch. Returns an unsigned open, close, stop update, add, or partial remove, a backtest with its trade ledger and skip summary, or does nothing. Does not draw a chart.',
    parameters: {
      asset: { type: 'string', description: 'Hyperliquid market name, such as BTC. A contract address is rejected.' },
      interval: { type: 'string', description: 'Candle interval, such as 4h.' },
      candleCount: { type: 'number', description: 'Number of candles to keep.' },
      analysisType: { type: 'string', description: 'Library analysis id, underscores, no hyphens.' },
      mode: { type: 'string', description: 'dry-run, backtest, or live.' },
      momentum: { type: 'boolean', description: 'When true, an open requires a clear momentum idea on the same side. A close does not.' },
      candlestick: { type: 'boolean', description: 'When true, an open requires a clear candlestick idea on the same side. A close does not.' },
      analysisSettings: { type: 'object', description: 'Periods and entry settings for the named type. Passed in by the caller. minConfidenceCandles from the candlestick desk block is the hit gate for candlestick_patterns and for the candlestick switch. Default 0.8 when that line is absent.' },
      stopToEntry: { type: 'string', description: 'Two percents, such as "50 5" or "50% 5%". When the previous candle closes at least the first percent of the way from entry to target, move the stop once to entry plus the second percent of that distance.' },
      addToPosition: { type: 'string', description: 'Two percents, such as "50 25". When the previous candle closes at least the first percent of the way from entry to target, add the second percent of the remaining free collateral once.' },
      removeFromPosition: { type: 'string', description: 'Two percents, such as "75 50". When the previous candle closes at least the first percent of the way from entry to target, close the second percent of the current position once.' },
      trailingStop: { type: 'string', description: 'Two percents, such as "50 5". When the previous candle closes at least the first percent of the way from entry to target, set the stop back from that close by the second percent of the entry-to-target range. Later closes tighten it again.' },
      lookbackDays: { type: 'number' },
      percent: { type: 'number' },
      initialBalanceUsdc: { type: 'string' },
      maxSeriesPoints: { type: 'number' },
      chainId: { type: 'number' },
    },
    async execute(args) {
      const setupNotice = readInstantSetupNotice(pi)
      const finish = (result) => (
        setupNotice && result && typeof result === 'object' ? { ...result, setupNotice } : result
      )
      const asset = String(args.asset || '').trim()
      if (!asset) return finish({ error: 'Pass a Hyperliquid market name, such as BTC.' })
      if (isAddress(asset)) {
        return finish({ error: 'A contract address is rejected. Pass the Hyperliquid market name, such as BTC.' })
      }
      const interval = String(args.interval || '4h')
      const candleCount = Math.floor(Number(args.candleCount))
      if (!Number.isFinite(candleCount) || candleCount < 2) {
        return finish({ error: 'candleCount must be a number of candles.' })
      }
      const analysisType = String(args.analysisType || '')
      if (!ANALYSIS_TYPES.includes(analysisType)) {
        return finish({ error: `analysisType must be one of: ${ANALYSIS_TYPES.join(', ')}.` })
      }
      const mode = String(args.mode || 'dry-run')
      if (mode !== 'dry-run' && mode !== 'backtest' && mode !== 'live') {
        return finish({ error: 'mode must be dry-run, backtest, or live.' })
      }
      const settings = args.analysisSettings && typeof args.analysisSettings === 'object' ? { ...args.analysisSettings } : {}
      const minConfidenceCandles = resolveMinConfidenceCandles(settings)
      const chainId = Number(args.chainId) > 0 ? Number(args.chainId) : CHAIN_ID
      const percent = Number(args.percent) > 0 ? Number(args.percent) : 50
      const momentumOn = asBool(args.momentum)
      const candlestickOn = asBool(args.candlestick)
      const parsedRules = parseManagementRules(args)
      if (parsedRules.error) return finish({ error: parsedRules.error })
      const management = parsedRules.rules

      let resolved
      try {
        resolved = await hl.hyperliquidResolvePerpMarket({ chainId, coin: asset })
      } catch (err) {
        return finish({ error: err instanceof Error ? err.message : String(err) })
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
        return finish({ error: `Hyperliquid returned ${candles.length} candles; candleCount is ${candleCount}.` })
      }

      const leverageRead = await readKeyGenLeverage(pi, hl, chainId, market)
      if (leverageRead.error) return finish({ error: leverageRead.error })

      if (mode === 'backtest') {
        return finish(await backtest({
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
          management,
          leverage: leverageRead.leverage,
          szDecimals: resolved.szDecimals,
          initialBalanceUsdc: args.initialBalanceUsdc || '1000',
          maxSeriesPoints: Number(args.maxSeriesPoints) > 0 ? Math.floor(Number(args.maxSeriesPoints)) : 400,
        }))
      }

      const primary = await runAnalysis(pi, ideas, analysisType, candles, settings, minConfidenceCandles)
      if (primary.error) return finish({ error: primary.error })
      const book = await readBook(pi, hl, chainId, market, mode)
      if (book.error) return finish({ error: book.error })
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
      if (decision.error) return finish({ error: decision.error })
      const rows = candleRows(candles)
      const last = rows.at(-1)
      const price = decision.idea && decision.idea.entry && decision.idea.entry.price
        ? decision.idea.entry.price
        : last && last.close
      const needsSpot = mode === 'live' && !(book.spot > 0)
      const userNotice = needsSpot ? spotTopUpNotice(market, leverageRead.leverage) : null
      let liveDecision = decision.decision
      let liveReason = decision.reason
      let payload = {}
      const managed = decision.decision !== 'close' && book.position && managementActive(management)
        ? await liveManagement({
          pi,
          hl,
          chainId,
          book,
          rows,
          rules: management,
          leverage: leverageRead.leverage,
          withdrawable: leverageRead.withdrawable,
          market,
          szDecimals: resolved.szDecimals,
          idea: decision.idea,
        })
        : null
      if (needsSpot && decision.decision === 'open') {
        liveDecision = 'nothing'
        liveReason = userNotice
      } else if (managed && managed.actions.length) {
        liveDecision = managed.actions.length === 1 ? managed.actions[0].action : 'manage'
        liveReason = managed.reason
        payload = {
          actions: managed.actions,
          ...(managed.actions.length === 1 ? managed.actions[0] : {}),
        }
      } else if ((decision.decision === 'open' || decision.decision === 'close') && price) {
        const collateral = mode === 'live' ? leverageRead.accountValue : book.paperUsdc
        const notional = tradableNotional(collateral, percent, leverageRead.leverage)
        if (mode === 'live' && decision.decision === 'open' && !(collateral > 0)) {
          return finish({ error: 'The KeyGen perp account has no collateral for this order.' })
        }
        if (mode === 'live' && decision.decision === 'open' && notional / leverageRead.leverage > collateral) {
          return finish({ error: 'The KeyGen perp collateral is below the sized order.' })
        }
        const size = decision.decision === 'close' && book.positionSize
          ? book.positionSize
          : (price > 0 ? notional / price : 0)
        payload = orderPayload(decision.decision, market, decision.side, price, size, resolved.szDecimals)
      }
      return finish({
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
        side: (managed && managed.actions.length ? book.position : decision.side) || null,
        confidence: decision.idea ? decision.idea.confidence : null,
        position: book.position,
        ...payload,
      })
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
  const withdrawable = num(context && context.account && context.account.withdrawableUsd) || 0
  return { leverage, accountValue, withdrawable }
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
    entry: row ? num(row.entryPx) || 0 : 0,
    margin: row ? num(row.marginUsedUsd) || 0 : 0,
    paperUsdc: spot,
    balanceRead: true,
    spot,
  }
}

function positionTriggers(hl, orders, coin, isLong, entry) {
  const classify = hl && hl.hyperliquidOpenOrderTpslKind
  let stop = null
  let target = null
  if (typeof classify !== 'function') return { stop, target }
  for (const order of orders || []) {
    if (String(order.coin || '').toLowerCase() !== String(coin).toLowerCase()) continue
    let kind = null
    try {
      kind = classify(order, { isLong, referencePx: entry })
    } catch {
      kind = null
    }
    const px = num(order.triggerPx)
    if (!(px > 0)) continue
    if (kind === 'sl') stop = px
    if (kind === 'tp') target = px
  }
  return { stop, target }
}

function managementAction(body) {
  return { payload: body, ...body }
}

function managementActions(planned, coin, side, szDecimals) {
  const actions = []
  const reasons = []
  const stopPx = planned.trailChange != null ? planned.trailChange : planned.stopChange
  if (stopPx != null) {
    const stopLossTriggerPxHuman = roundTo(stopPx, 6)
    actions.push(managementAction({
      kind: 'hyperliquid-perp',
      action: 'update-stop',
      tool: 'ctm_hyperliquid_build_update_position_tpsl_multisign',
      coin,
      side,
      stopLossTriggerPxHuman,
    }))
    reasons.push(planned.trailChange != null
      ? `Previous close reached trailing-stop. The stop moves to ${stopLossTriggerPxHuman}.`
      : `Previous close reached stop-to-entry. The stop moves to ${stopLossTriggerPxHuman}.`)
  }
  if (planned.remove) {
    const limitPxHuman = roundTo(planned.remove.price, 6)
    const szHuman = roundTo(planned.remove.qty, szDecimals)
    actions.push(managementAction({
      kind: 'hyperliquid-perp',
      action: 'remove',
      tool: 'ctm_hyperliquid_build_close_multisign',
      coin,
      side,
      isLong: side === 'long',
      limitPxHuman,
      szHuman,
      reduceOnly: true,
    }))
    reasons.push('Previous close reached remove-from-position.')
  }
  if (planned.add) {
    const limitPxHuman = roundTo(planned.add.price, 6)
    const szHuman = roundTo(planned.add.qty, szDecimals)
    actions.push(managementAction({
      kind: 'hyperliquid-perp',
      action: 'add',
      tool: 'ctm_hyperliquid_build_limit_order_multisign',
      coin,
      side,
      isBuy: side === 'long',
      limitPxHuman,
      szHuman,
      tif: 'ioc',
      reduceOnly: false,
    }))
    reasons.push('Previous close reached add-to-position.')
  }
  return { actions, reason: reasons.join(' ') }
}

async function liveManagement(input) {
  const book = input.book
  const rows = input.rows || []
  const prev = rows.length >= 2 ? rows[rows.length - 2] : null
  const last = rows.length ? rows[rows.length - 1] : null
  const prevClose = prev && prev.close
  const fillPrice = last && last.close
  const entry = book.entry
  const qty = book.positionSize
  if (!(prevClose > 0) || !(fillPrice > 0) || !(entry > 0) || !(qty > 0)) {
    return { actions: [], reason: '' }
  }
  let triggers = { stop: null, target: null }
  if (typeof input.hl.hyperliquidFetchOrdersForExecutor === 'function') {
    try {
      const address = input.pi.preferredKeyGenAddress()
      const fetched = await input.hl.hyperliquidFetchOrdersForExecutor({
        chainId: input.chainId,
        executorAddress: address,
      })
      triggers = positionTriggers(input.hl, fetched && fetched.orders, input.market, book.position === 'long', entry)
    } catch {
      triggers = { stop: null, target: null }
    }
  }
  const fromIdea = protectiveLevels(book.position, entry, input.idea).target
  const target = triggers.target || fromIdea
  const margin = book.margin > 0 ? book.margin : qty * entry / input.leverage
  const planned = planManagement({
    side: book.position,
    entry,
    qty,
    margin,
    freeUsdc: input.withdrawable || 0,
    collateralIsWithdrawable: true,
    leverage: input.leverage,
    stop: triggers.stop,
    target,
    prevClose,
    fillPrice,
    rules: input.rules,
    done: { stop: false, add: false, remove: false },
  })
  return managementActions(planned, input.market, book.position, input.szDecimals)
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
  const rules = input.management
  let managed = { stop: false, add: false, remove: false }
  function markedEquity(mark) {
    const openPnl = position && qty && mark
      ? (position === 'long' ? (mark - entry) * qty : (entry - mark) * qty)
      : 0
    return usdc + (position && qty ? margin + openPnl : 0)
  }
  function pushAdjusted(reason, barIndex, extra) {
    const at = rows[barIndex]
    ledger.push({
      status: 'adjusted',
      side: position,
      reason,
      entryPrice: Number(entry.toFixed(6)),
      exitPrice: null,
      entryTimeMs: openFill ? openFill.entryTimeMs : null,
      exitTimeMs: at && at.timestampMs != null ? at.timestampMs : null,
      barsHeld: barIndex - openedAt,
      qty: Number(qty.toFixed(8)),
      margin: Number(margin.toFixed(6)),
      pnl: Number((extra.pnl || 0).toFixed(6)),
      balanceUsdc: Number(markedEquity(extra.mark).toFixed(6)),
      ...(extra.stopPrice != null ? { stopPrice: Number(extra.stopPrice.toFixed(6)) } : {}),
      ...(extra.fillPrice != null ? { fillPrice: Number(extra.fillPrice.toFixed(6)) } : {}),
    })
  }
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
    managed = { stop: false, add: false, remove: false }
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
    if (position && qty > 0 && i > openedAt && managementActive(rules)) {
      const prevClose = rows[i - 1] && rows[i - 1].close
      const fillPrice = bar && (bar.open != null ? bar.open : bar.close)
      const planned = planManagement({
        side: position,
        entry,
        qty,
        margin,
        freeUsdc: usdc,
        leverage,
        stop: levels && levels.invalidation,
        target: levels && levels.target,
        prevClose,
        fillPrice,
        rules,
        done: managed,
      })
      managed = planned.done
      if (planned.stopChange != null && levels) {
        levels.invalidation = planned.stopChange
        pushAdjusted('stop-to-entry', i, { mark: prevClose, stopPrice: planned.stopChange })
      }
      if (planned.trailChange != null && levels) {
        levels.invalidation = planned.trailChange
        pushAdjusted('trailing-stop', i, { mark: prevClose, stopPrice: planned.trailChange })
      }
      const throughStop = levels && levels.invalidation != null && fillPrice > 0
        && (position === 'long' ? fillPrice <= levels.invalidation : fillPrice >= levels.invalidation)
      if (!throughStop && planned.remove) {
        if (planned.remove.full) {
          closeBook(planned.remove.price, bar && bar.timestampMs, 'remove', null, i)
        } else {
          usdc += planned.remove.margin + planned.remove.pnl
          qty -= planned.remove.qty
          margin -= planned.remove.margin
          if (levels) levels.liquidation = liquidationPrice(position, entry, leverage)
          pushAdjusted('remove', i, {
            mark: planned.remove.price,
            fillPrice: planned.remove.price,
            pnl: planned.remove.pnl,
          })
        }
      }
      if (position && qty > 0 && planned.add) {
        const addQty = planned.add.qty
        entry = (entry * qty + planned.add.price * addQty) / (qty + addQty)
        qty += addQty
        margin += planned.add.margin
        usdc -= planned.add.margin
        if (levels) levels.liquidation = liquidationPrice(position, entry, leverage)
        pushAdjusted('add', i, { mark: planned.add.price, fillPrice: planned.add.price, pnl: 0 })
      }
    }
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
    ...(managementActive(rules) ? { management: rules } : {}),
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
