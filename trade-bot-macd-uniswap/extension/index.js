import { z } from 'zod'
import { Contract, JsonRpcProvider } from 'ethers'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/*
 * trade-bot-macd-uniswap
 *
 * MACD(12,26,9) pullback entries, executed as Uniswap V4 swaps.
 *   Bullish Entry: MACD crosses ABOVE signal, below the zero line, after the MACD
 *                  line has been below zero for at least `pullbackBars` bars. Buy.
 *   Bearish Entry: MACD crosses BELOW signal, above the zero line, after the MACD
 *                  line has been above zero for at least `pullbackBars` bars. Sell.
 *
 * This entrypoint NEVER calls pi.signRequest and never broadcasts. Every trade path
 * returns an unsigned payload; the agent opens the multi-sign request.
 *
 * SkipPermit2: uniswapTradeQuote/uniswapCreateSwap as documented in the loaded
 * library index name no permit2 field, so no permit2 argument is passed here. The
 * field name was deliberately not invented — see SKILL.md "SkipPermit2".
 */

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

const USDC_BY_CHAIN = {
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  59144: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  4663: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}

const SIGNAL_PERIODS = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }

const DEFAULTS = {
  interval: '4h',
  lookbackDays: 60,
  percentOfBalance: 50,
  pullbackBars: 2,
  minCandles: 100,
  minBacktestCandles: 200,
  initialBalanceUsdc: '1000',
  feeBps: 30,
  tokenDecimals: 18,
}

const INTERVALS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w']

const INTERVAL_HOURS = {
  '5m': 5 / 60,
  '15m': 15 / 60,
  '30m': 0.5,
  '1h': 1,
  '2h': 2,
  '4h': 4,
  '6h': 6,
  '8h': 8,
  '12h': 12,
  '1d': 24,
  '1w': 168,
}

function resolveCandleWindow(interval, lookbackDays, candleCount) {
  const count = candleCount == null || candleCount === '' ? null : Math.floor(Number(candleCount))
  const explicitDays = Number(lookbackDays) > 0 ? Number(lookbackDays) : null
  if (count != null && Number.isFinite(count) && count > 0) {
    const hours = INTERVAL_HOURS[interval] || 4
    const needed = Math.ceil((count * hours) / 24) + 1
    return {
      lookbackDays: explicitDays != null ? Math.max(explicitDays, needed) : needed,
      candleCount: count,
    }
  }
  return { lookbackDays: explicitDays != null ? explicitDays : 60, candleCount: null }
}

function takeLastCandles(bars, candleCount, minCandles) {
  const need = candleCount != null ? Math.max(minCandles, candleCount) : minCandles
  if (bars.length < need) {
    const asked = candleCount != null ? `candleCount ${candleCount}` : `at least ${minCandles} candles`
    return { error: `Needs ${asked}; got ${bars.length}.`, usableCandles: bars.length }
  }
  const used = candleCount != null ? bars.slice(bars.length - candleCount) : bars
  return { bars: used }
}


/* ---------- small helpers ---------- */

function num(v) {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}

function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}

/* integer base-unit conversion without floating point drift */
function toBaseUnits(human, decimals) {
  const s = String(human).trim()
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return '0'
  const [whole, frac = ''] = s.split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  const combined = `${whole || '0'}${padded}`.replace(/^0+(?=\d)/, '')
  return combined === '' ? '0' : combined
}

function resolveUsdc(chainId, override) {
  if (override) return override
  return USDC_BY_CHAIN[chainId] || null
}

/* Subgraph close is token0 per token1. A USDC buyer needs USDC per token. */
function invertOhlcBar(bar) {
  const inv = (n) => (typeof n === 'number' && n > 0 ? 1 / n : null)
  const open = inv(bar.open)
  const close = inv(bar.close)
  const high = inv(Math.min(bar.high, bar.low))
  const low = inv(Math.max(bar.high, bar.low))
  if (![open, high, low, close].every((n) => n !== null && Number.isFinite(n))) return null
  return { open, high, low, close, ...(bar.volume !== undefined ? { volume: bar.volume } : {}) }
}

function closesAreUsdcPerToken(args) {
  const quoteIsToken0PerToken1 = (args.priceQuote || 'token0PerToken1') !== 'token1PerToken0'
  let token0IsUsdc = null
  if (args.tokenAddress && args.usdcAddress) {
    token0IsUsdc = String(args.usdcAddress).toLowerCase() < String(args.tokenAddress).toLowerCase()
  } else if (typeof args.symbol === 'string' && args.symbol.includes('/')) {
    const [left, right] = args.symbol.split('/').map((s) => s.trim().toUpperCase())
    if (left === 'USDC') token0IsUsdc = true
    else if (right === 'USDC') token0IsUsdc = false
  }
  if (token0IsUsdc === null) return null
  const numeratorIsUsdc = quoteIsToken0PerToken1 ? token0IsUsdc : !token0IsUsdc
  return numeratorIsUsdc
}

function orientBarsToUsdcPerToken(bars, args) {
  const symbol = typeof args.symbol === 'string' ? args.symbol : ''
  const symbolHasUsdc = /(^|\/)\s*USDC\s*(\/|$)/i.test(symbol)
  if (!args.usdcPair && !symbolHasUsdc) {
    return { bars, priceUnit: 'subgraph-close', priceInverted: false }
  }
  const already = closesAreUsdcPerToken(args)
  if (already === null) {
    return { bars, priceUnit: 'subgraph-close', priceInverted: false }
  }
  if (already) {
    return { bars, priceUnit: 'usdc-per-token', priceInverted: false }
  }
  return {
    bars: bars.map(invertOhlcBar).filter(Boolean),
    priceUnit: 'usdc-per-token',
    priceInverted: true,
  }
}


/* ---------- MACD result normalisation ---------- */

// The MACD result may be objects ({ macd, signal, histogram }) or parallel arrays.
function extractMacdSeries(result) {
  const macd = []
  const signal = []
  const histogram = []
  if (!Array.isArray(result)) return null

  if (Array.isArray(result[0])) {
    for (const row of result) {
      macd.push(num(row[0]))
      signal.push(num(row[1]))
      histogram.push(num(row[2]))
    }
    return { macd, signal, histogram }
  }

  const keysSeen = {}
  for (const point of result) {
    if (!point || typeof point !== 'object') return null
    for (const k of Object.keys(point)) keysSeen[k] = true
    macd.push(pickNumber(point, ['macd', 'macdLine', 'MACD', 'value', 'line']))
    signal.push(pickNumber(point, ['signal', 'signalLine', 'Signal', 'signalValue']))
    histogram.push(pickNumber(point, ['histogram', 'hist', 'Histogram', 'histValue']))
  }

  if (macd.every((v) => v === null) && signal.every((v) => v === null)) {
    const keys = Object.keys(keysSeen)
    if (keys.length >= 2) {
      for (let i = 0; i < result.length; i += 1) {
        const a = num(result[i][keys[0]])
        const b = num(result[i][keys[1]])
        macd[i] = a
        signal[i] = b
      }
    }
  }
  return { macd, signal, histogram }
}

function pickNumber(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined) {
      const n = num(obj[k])
      if (n !== null) return n
    }
  }
  return null
}

/*
 * The technical-indicators market library answers with an envelope:
 *   success -> { ok: true,  data: { result: <indicator output> } }
 *   failure -> { ok: false, reason: '<why it failed>' }
 * Older builds returned the bare indicator output, so fall back to that shape when
 * no boolean `ok` is present. Only calc.data.result is read when ok is true, and
 * calc.reason is surfaced whenever ok is not true.
 */
function unwrapIndicatorResult(calc) {
  if (calc && typeof calc === 'object' && typeof calc.ok === 'boolean') {
    if (!calc.ok) {
      const reason =
        calc.reason || calc.error || 'The indicator returned ok:false without a reason.'
      return { ok: false, result: null, reason }
    }
    const payload = calc.data
    const result =
      payload && typeof payload === 'object' && 'result' in payload ? payload.result : payload
    return { ok: true, result, reason: null }
  }
  const result =
    calc && typeof calc === 'object' && 'result' in calc ? calc.result : calc
  return { ok: true, result, reason: null }
}

// MACD output may be shorter than the candle array (warmup dropped). Align the tail.
function macdOffset(bars, macdSeries) {
  return Math.max(0, bars.length - macdSeries.macd.length)
}

/* ---------- rule ---------- */

function zeroRunLength(macd, endIndex, mode) {
  let n = 0
  for (let i = endIndex; i >= 0; i -= 1) {
    const v = macd[i]
    if (typeof v !== 'number') break
    const ok = mode === 'below' ? v < 0 : v > 0
    if (!ok) break
    n += 1
  }
  return n
}

function crossAt(macd, signal, i) {
  if (i < 1) return 'none'
  const pm = macd[i - 1]
  const ps = signal[i - 1]
  const cm = macd[i]
  const cs = signal[i]
  if ([pm, ps, cm, cs].some((v) => typeof v !== 'number')) return 'none'
  if (pm <= ps && cm > cs) return 'bullish'
  if (pm >= ps && cm < cs) return 'bearish'
  return 'none'
}

// Decide the action on a single bar index.
function entryAt(macd, signal, i, pullbackBars) {
  const cross = crossAt(macd, signal, i)
  const cm = macd[i]
  const cs = signal[i]
  const zeroLine = typeof cm !== 'number' ? 'unknown' : cm > 0 ? 'above' : cm < 0 ? 'below' : 'at'
  const base = {
    barIndex: i,
    cross,
    zeroLine,
    macd: typeof cm === 'number' ? cm : null,
    signal: typeof cs === 'number' ? cs : null,
    histogram: typeof cm === 'number' && typeof cs === 'number' ? cm - cs : null,
  }

  if (cross === 'none') {
    return { ...base, action: 'none', zeroBars: 0, reason: 'No MACD/signal cross on this bar.' }
  }

  if (cross === 'bullish') {
    if (!(cm < 0)) {
      return { ...base, action: 'none', zeroBars: 0, reason: 'Bullish cross but the MACD line is not below zero — not a Bullish Entry.' }
    }
    const run = zeroRunLength(macd, i, 'below')
    if (run < pullbackBars) {
      return {
        ...base,
        action: 'none',
        zeroBars: run,
        reason: `Bullish cross below zero, but the MACD line has been below zero for only ${run} bar(s); pullbackBars=${pullbackBars} requires at least ${pullbackBars}.`,
      }
    }
    return {
      ...base,
      action: 'buy',
      entry: 'bullish',
      entryLabel: 'Bullish Entry',
      zeroBars: run,
      reason: `Bullish Entry: MACD crossed above signal below zero after ${run} bar(s) below zero (pullback >= ${pullbackBars}).`,
    }
  }

  if (!(cm > 0)) {
    return { ...base, action: 'none', zeroBars: 0, reason: 'Bearish cross but the MACD line is not above zero — not a Bearish Entry.' }
  }
  const run = zeroRunLength(macd, i, 'above')
  if (run < pullbackBars) {
    return {
      ...base,
      action: 'none',
      zeroBars: run,
      reason: `Bearish cross above zero, but the MACD line has been above zero for only ${run} bar(s); pullbackBars=${pullbackBars} requires at least ${pullbackBars}.`,
    }
  }
  return {
    ...base,
    action: 'sell',
    entry: 'bearish',
    entryLabel: 'Bearish Entry',
    zeroBars: run,
    reason: `Bearish Entry: MACD crossed below signal above zero after ${run} bar(s) above zero.`,
  }
}

function lastUsableIndex(macd, signal) {
  for (let i = macd.length - 1; i >= 1; i -= 1) {
    if (typeof macd[i] === 'number' && typeof signal[i] === 'number' && typeof macd[i - 1] === 'number') return i
  }
  return -1
}

function evaluateLatest(macdSeries, pullbackBars, crossLookback) {
  const { macd, signal } = macdSeries
  const last = lastUsableIndex(macd, signal)
  if (last < 1) {
    return {
      action: 'none',
      cross: 'none',
      zeroLine: 'unknown',
      macd: null,
      signal: null,
      histogram: null,
      barsSinceCross: null,
      zeroBars: 0,
      reason: 'Not enough valid MACD/signal points to evaluate a cross.',
    }
  }
  let first = null
  for (let off = 0; off <= crossLookback; off += 1) {
    const i = last - off
    if (i < 1) break
    const res = entryAt(macd, signal, i, pullbackBars)
    const wrapped = { ...res, barsSinceCross: off }
    if (res.action !== 'none') return wrapped
    if (off === 0) first = wrapped
  }
  return first
}

/* ---------- position state (user_folder:write) ---------- */

function stateCandidates() {
  const cwd = process.cwd()
  const rel = join('plugins', 'trade-bot-macd-uniswap', '.position-state.json')
  return [join(cwd, rel), join(cwd, '..', rel), join(cwd, '.position-state.json')]
}

function stateKey(chainId, tokenAddress, interval) {
  return `${chainId}:${String(tokenAddress).toLowerCase()}:${interval}`
}

async function readState() {
  for (const path of stateCandidates()) {
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') continue
      continue
    }
    try {
      const parsed = JSON.parse(raw)
      const data = parsed && typeof parsed === 'object' && parsed.positions ? parsed : { positions: {} }
      return { ok: true, path, data }
    } catch {
      return { ok: true, path, data: { positions: {} }, note: `State file ${path} was not valid JSON; treated as empty.` }
    }
  }
  return { ok: true, path: stateCandidates()[0], data: { positions: {} }, note: 'No position state file yet.' }
}

async function writeState(data) {
  const path = stateCandidates()[0]
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return { ok: true, path }
  } catch (err) {
    return { ok: false, path, error: err?.message || String(err) }
  }
}

/* ---------- quote helper ---------- */

// SkipPermit2: no permit2 argument is passed. The loaded library index does not name
// the permit2 field for uniswapTradeQuote / uniswapCreateSwap, so it is omitted rather
// than guessed.
async function buildSwap(uni, { chainId, tokenIn, tokenOut, amountWei, slippage, swapper }) {
  const quote = await uni.uniswapTradeQuote({
    type: 'EXACT_INPUT',
    amount: amountWei,
    tokenIn,
    tokenOut,
    chainId,
    swapper,
    ...(slippage !== undefined ? { slippage } : {}),
  })
  const quoteJson = quote?.quote || quote
  const swap = await uni.uniswapCreateSwap({ fullQuoteFromPermit: quoteJson, useServerProxy: false })
  return { quote, quoteJson, swap }
}

function quoteOutAmount(quoteJson) {
  const candidates = [
    quoteJson?.quote?.output?.amount,
    quoteJson?.output?.amount,
    quoteJson?.amountOut,
    quoteJson?.quote?.outputAmount,
  ]
  for (const c of candidates) {
    if (c !== undefined && c !== null) return String(c)
  }
  return null
}

/* ---------- backtest ---------- */

function runBacktest(bars, macdSeries, opts) {
  const { percentOfBalance, pullbackBars, feeBps, initialBalanceUsdc } = opts
  const { macd, signal } = macdSeries
  const offset = macdOffset(bars, macdSeries)

  let usdc = Number(initialBalanceUsdc)
  let tokens = 0
  let entryPrice = null
  let entryBar = null
  const initial = usdc
  const trades = []
  const balanceSeries = []
  let peak = usdc
  let maxDrawdownPct = 0
  let feeTotal = 0
  let barsWithSignal = 0

  for (let i = 0; i < macd.length; i += 1) {
    const bar = bars[offset + i]
    const price = bar ? num(bar.close) : null
    if (price === null || price <= 0) {
      balanceSeries.push(Number(usdc.toFixed(6)))
      continue
    }

    if (i >= 1) {
      const verdict = entryAt(macd, signal, i, pullbackBars)
      if (verdict.action !== 'none') barsWithSignal += 1

      if (verdict.action === 'buy' && tokens === 0) {
        const spend = (usdc * percentOfBalance) / 100
        const fee = (spend * feeBps) / 10000
        const net = spend - fee
        if (net > 0) {
          tokens = net / price
          usdc -= spend
          feeTotal += fee
          entryPrice = price
          entryBar = offset + i
          trades.push({
            action: 'buy',
            bar: offset + i,
            price: Number(price.toFixed(8)),
            usdcSpent: Number(spend.toFixed(6)),
            tokens: Number(tokens.toFixed(8)),
            reason: verdict.reason,
          })
        }
      } else if (verdict.action === 'sell' && tokens > 0) {
        const gross = tokens * price
        const fee = (gross * feeBps) / 10000
        usdc += gross - fee
        feeTotal += fee
        const pnlPct = entryPrice ? ((price - entryPrice) / entryPrice) * 100 : null
        trades.push({
          action: 'sell',
          bar: offset + i,
          price: Number(price.toFixed(8)),
          usdcReceived: Number((gross - fee).toFixed(6)),
          tokens: Number(tokens.toFixed(8)),
          pnlPct: pnlPct === null ? null : Number(pnlPct.toFixed(4)),
          entryBar,
          reason: verdict.reason,
        })
        tokens = 0
        entryPrice = null
        entryBar = null
      }
    }

    const equity = usdc + tokens * price
    balanceSeries.push(Number(equity.toFixed(6)))
    if (equity > peak) peak = equity
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100
      if (dd > maxDrawdownPct) maxDrawdownPct = dd
    }
  }

  const lastBar = bars[bars.length - 1]
  const lastPrice = lastBar ? num(lastBar.close) : null
  const finalBalance = balanceSeries.length ? balanceSeries[balanceSeries.length - 1] : usdc
  const firstClose = num(bars[offset]?.close ?? bars[0]?.close)
  const buyAndHoldPct =
    firstClose && lastPrice ? ((lastPrice - firstClose) / firstClose) * 100 : null
  const priceUsdc = (n) => (n ? Number(n.toPrecision(10)) : null)

  return {
    initialBalanceUsdc: Number(initial.toFixed(6)),
    finalBalanceUsdc: finalBalance,
    finalBalanceRatioPct: initial > 0 ? Number(((finalBalance / initial) * 100).toFixed(4)) : null,
    pctProfit: initial > 0 ? Number((((finalBalance - initial) / initial) * 100).toFixed(4)) : null,
    buyAndHoldPct: buyAndHoldPct === null ? null : Number(buyAndHoldPct.toFixed(4)),
    firstClose: priceUsdc(firstClose),
    lastClose: priceUsdc(lastPrice),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    feeTotalUsdc: Number(feeTotal.toFixed(6)),
    tradeCount: trades.length,
    barsWithSignal,
    openPosition: tokens > 0
      ? { tokens: Number(tokens.toFixed(8)), entryBar, entryPrice: entryPrice === null ? null : Number(entryPrice.toFixed(8)) }
      : null,
    balanceSeries,
    trades,
  }
}

/* ---------- plugin ---------- */

export default async function (pi) {
  const ta = await pi.importMarket('ta')
  const ohlcv = await pi.importMarket('ohlcv')
  const uni = await pi.importDefi('protocols/evm/uniswap-v4')

  const candleSchema = z
    .object({
      open: z.coerce.number(),
      high: z.coerce.number(),
      low: z.coerce.number(),
      close: z.coerce.number(),
      volume: z.coerce.number().optional(),
    })
    .passthrough()

  async function computeMacd(bars) {
    const calc = await ta.calculateTechnicalIndicator({
      indicator: 'macd',
      params: SIGNAL_PERIODS,
      input: { candles: bars },
    })
    const unwrapped = unwrapIndicatorResult(calc)
    if (!unwrapped.ok) return { calc, series: null, reason: unwrapped.reason }
    const series = extractMacdSeries(unwrapped.result)
    return { calc, series, reason: null }
  }

  const USDC_FEE_TIERS = [
    { fee: 3000, tickSpacing: 60 },
    { fee: 500, tickSpacing: 10 },
    { fee: 10000, tickSpacing: 200 },
    { fee: 100, tickSpacing: 1 },
  ]

  function candleRows(input) {
    if (Array.isArray(input)) return input
    if (!input || typeof input !== 'object') return []
    if (Array.isArray(input.candles)) return input.candles
    if (Array.isArray(input.bars)) return input.bars
    const data = input.data
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (Array.isArray(data.candles)) return data.candles
      if (Array.isArray(data.bars)) return data.bars
      if (Array.isArray(data.result)) return data.result
    }
    const extracted = ohlcv.extractOhlcvBarsFromUnknown(input)
    if (Array.isArray(extracted)) return extracted
    if (extracted && typeof extracted === 'object' && Array.isArray(extracted.bars)) return extracted.bars
    return []
  }

  function normaliseBars(input) {
    return candleRows(input)
      .map((b) => {
        if (!b || typeof b !== 'object') return null
        const open = Number(b.open ?? b.o)
        const high = Number(b.high ?? b.h)
        const low = Number(b.low ?? b.l)
        const close = Number(b.close ?? b.c)
        if (![open, high, low, close].every((n) => Number.isFinite(n))) return null
        const volumeRaw = b.volume ?? b.volumeUSD ?? b.volumeUsd ?? b.v
        const volume = volumeRaw === undefined ? undefined : Number(volumeRaw)
        return {
          open,
          high,
          low,
          close,
          ...(Number.isFinite(volume) ? { volume } : {}),
        }
      })
      .filter(Boolean)
  }

  function chartSummaryOnly(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false
    if (String(input.agentView || '').toLowerCase() === 'slim') return true
    const summary = input.meta && typeof input.meta === 'object' && input.meta.ohlcvSummary
    return Boolean(summary) && !Array.isArray(input.candles)
  }

  async function loadBars(input, minCandles) {
    const interval = input.interval || DEFAULTS.interval
    const window = resolveCandleWindow(interval, input.lookbackDays, input.candleCount)
    const lookbackDays = window.lookbackDays
    const candleCount = window.candleCount
    const dataSource = input.dataSource || (input.candles?.length ? 'provided' : 'uniswap-v4')
    if (candleCount != null && candleCount < minCandles) {
      return {
        error: `candleCount ${candleCount} is below the minimum of ${minCandles} for this tool.`,
        interval,
        lookbackDays,
        candleCount,
        minCandles,
        dataSource,
      }
    }
    if (dataSource === 'provided') {
      if (chartSummaryOnly(input.candles) || chartSummaryOnly(input)) {
        return {
          error:
            'The chart tool returned a summary only, with no candle rows. Leave dataSource as uniswap-v4 and pass tokenAddress or poolReference. This plugin fetches the Uniswap V4 candles.',
          interval,
          lookbackDays,
          dataSource,
        }
      }
      if (!input.candles?.length) {
        return { error: 'dataSource=provided needs candles[] with open, high, low, and close.', interval, lookbackDays, dataSource }
      }
      const normalised = normaliseBars(input.candles)
      const taken = takeLastCandles(normalised, candleCount, minCandles)
      if (taken.error) {
        return {
          error: taken.error,
          interval,
          lookbackDays,
          candleCount,
          dataSource,
          usableCandles: taken.usableCandles,
          minCandles,
        }
      }
      return {
        bars: taken.bars,
        interval,
        lookbackDays,
        candleCount,
        dataSource,
        priceUnit: 'provided-close',
        priceInverted: false,
      }
    }

    if (!pi.variableConfigured('THE_GRAPH_API_KEY')) {
      return {
        error:
          'THE_GRAPH_API_KEY is not configured on this node. Uniswap V4 Graph candles need it. Add it under Variables. Nothing was fetched.',
        interval,
        lookbackDays,
        dataSource,
      }
    }

    const targets = []
    if (input.poolReference || input.existingPool) {
      targets.push({ poolReference: input.poolReference, existingPool: input.existingPool })
    } else {
      const usdc = resolveUsdc(input.chainId, input.usdcAddress)
      if (!input.tokenAddress || !usdc) {
        return {
          error:
            'dataSource=uniswap-v4 needs tokenAddress on a chain with a known USDC address, or poolReference, or existingPool.',
          interval,
          lookbackDays,
          dataSource,
        }
      }
      if (String(input.tokenAddress).toLowerCase() === String(usdc).toLowerCase()) {
        return { error: 'tokenAddress is the USDC address for this chain. Pass the other token.', interval, lookbackDays, dataSource }
      }
      for (const tier of USDC_FEE_TIERS) {
        targets.push({
          usdcPair: true,
          fee: tier.fee,
          tickSpacing: tier.tickSpacing,
          existingPool: {
            token0Address: input.tokenAddress,
            token1Address: usdc,
            fee: tier.fee,
            tickSpacing: tier.tickSpacing,
          },
        })
      }
    }

    const attempts = []
    let best = null
    for (const target of targets) {
      try {
        const raw = await uni.uniswapV4FetchOhlcv({
          chainId: input.chainId,
          interval,
          lookbackDays,
          ...(target.poolReference ? { poolReference: target.poolReference } : {}),
          ...(target.existingPool ? { existingPool: target.existingPool } : {}),
        })
        const bars = normaliseBars(raw)
        const attempt = {
          candles: bars.length,
          poolReference: raw && raw.poolReference,
          symbol: raw && raw.symbol,
          usdcPair: Boolean(target.usdcPair),
        }
        if (target.fee != null) attempt.fee = target.fee
        if (target.tickSpacing != null) attempt.tickSpacing = target.tickSpacing
        if (Array.isArray(raw && raw.warnings) && raw.warnings.length) attempt.warnings = raw.warnings
        attempts.push(attempt)
        if (!best || bars.length > best.bars.length) best = { bars, raw, attempt }
        if (bars.length >= minCandles) break
      } catch (err) {
        attempts.push({
          fee: target.fee,
          tickSpacing: target.tickSpacing,
          error: err && err.message ? String(err.message) : String(err),
        })
      }
    }

    const got = best ? best.bars.length : 0
    if (!best || got < minCandles) {
      return {
        error: `Needs at least ${minCandles} Uniswap V4 candles; got ${got}. The chart tool's summary has no rows this plugin can use. Pass poolReference if you already know the pool id.`,
        interval,
        lookbackDays,
        dataSource,
        minCandles,
        usableCandles: got,
        attempts,
      }
    }
    const oriented = orientBarsToUsdcPerToken(best.bars, {
      usdcPair: Boolean(best.attempt.usdcPair),
      tokenAddress: input.tokenAddress,
      usdcAddress: resolveUsdc(input.chainId, input.usdcAddress),
      priceQuote: best.raw && best.raw.priceQuote,
      symbol: best.raw && best.raw.symbol,
    })
    const taken = takeLastCandles(oriented.bars, candleCount, minCandles)
    if (taken.error) {
      return {
        error: taken.error,
        interval,
        lookbackDays,
        candleCount,
        dataSource,
        minCandles,
        usableCandles: taken.usableCandles,
        priceUnit: oriented.priceUnit,
        attempts,
      }
    }
    return {
      bars: taken.bars,
      priceUnit: oriented.priceUnit,
      priceInverted: oriented.priceInverted,
      interval,
      lookbackDays,
      candleCount,
      dataSource,
      poolReference: best.raw && best.raw.poolReference,
      poolSymbol: best.raw && best.raw.symbol,
      fee: best.attempt.fee ?? null,
      tickSpacing: best.attempt.tickSpacing ?? null,
      warnings: best.raw && best.raw.warnings,
    }
  }

  /* ---------------- tool 1: pure signal ---------------- */

  pi.registerTool({
    name: 'macd_signal',
    description:
      'Compute MACD (12/26/9) from closes or candles and evaluate the Bullish Entry (MACD crosses above signal below zero, after >= pullbackBars bars below zero) and Bearish Entry (MACD crosses below signal above zero, after >= pullbackBars bars above zero). Pure calculation: no network, no state, no sign request.',
    parameters: {
      type: 'object',
      properties: {
        candles: { type: 'array', items: { type: 'object' }, description: '{ open, high, low, close, volume? }[], oldest first' },
        closes: { type: 'array', items: { type: 'number' }, description: 'Close prices, oldest first. Use instead of candles.' },
        pullbackBars: { type: 'number', description: 'Bars the MACD line must sit below (or above) zero before the cross counts. Default 2.' },
        crossLookback: { type: 'number', description: 'How many bars back a cross still counts. Default 0 (last bar only).' },
        fastPeriod: { type: 'number', description: 'Default 12' },
        slowPeriod: { type: 'number', description: 'Default 26' },
        signalPeriod: { type: 'number', description: 'Default 9' },
      },
    },
    async execute(args) {
      const input = z
        .object({
          candles: z.array(candleSchema).optional(),
          closes: z.array(z.number()).optional(),
          pullbackBars: z.number().int().min(1).max(50).optional(),
          crossLookback: z.number().int().min(0).max(20).optional(),
          fastPeriod: z.number().int().positive().optional(),
          slowPeriod: z.number().int().positive().optional(),
          signalPeriod: z.number().int().positive().optional(),
        })
        .parse(args || {})

      if (!input.candles?.length && !input.closes?.length) {
        return JSON.stringify({
          error: 'Pass candles[] or closes[]. MACD(12,26,9) needs at least 35 closes before it produces a point.',
        })
      }

      const pullbackBars = input.pullbackBars ?? DEFAULTS.pullbackBars
      const params = {
        fastPeriod: input.fastPeriod ?? SIGNAL_PERIODS.fastPeriod,
        slowPeriod: input.slowPeriod ?? SIGNAL_PERIODS.slowPeriod,
        signalPeriod: input.signalPeriod ?? SIGNAL_PERIODS.signalPeriod,
      }
      const seriesInput = input.candles?.length ? { candles: input.candles } : { close: input.closes }

      let calc
      try {
        calc = await ta.calculateTechnicalIndicator({ indicator: 'macd', params, input: seriesInput })
      } catch (err) {
        return JSON.stringify({ error: `MACD calculation failed: ${err?.message || String(err)}` })
      }

      const unwrapped = unwrapIndicatorResult(calc)
      if (!unwrapped.ok) {
        return JSON.stringify({ error: 'MACD calculation failed.', reason: unwrapped.reason })
      }

      const series = extractMacdSeries(unwrapped.result)
      if (!series) {
        return JSON.stringify({
          error: 'Could not read the MACD result shape.',
          reason: 'ok was true but data.result did not contain MACD/signal series.',
          raw: unwrapped.result,
        })
      }

      const verdict = evaluateLatest(series, pullbackBars, input.crossLookback ?? 0)
      return JSON.stringify({
        indicator: 'MACD(12,26,9)',
        params,
        pullbackBars,
        ...verdict,
        action: verdict.action || 'none',
      })
    },
  })

  /* ---------------- tool 2: position state ---------------- */

  pi.registerTool({
    name: 'macd_position',
    description:
      'Read or clear the stored MACD position state (long/flat) for a chainId + tokenAddress + interval. The entry tool suppresses repeat buys while the state is long.',
    parameters: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'EVM chain id' },
        tokenAddress: { type: 'string', description: 'Token contract address (0x…)' },
        interval: { type: 'string', description: 'Candle interval. Default 4h' },
        reset: { type: 'boolean', description: 'true clears this key back to flat' },
        listAll: { type: 'boolean', description: 'true returns every stored position key' },
      },
      required: ['chainId'],
    },
    async execute(args) {
      const input = z
        .object({
          chainId: z.number().int().positive(),
          tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
          interval: z.enum(INTERVALS).optional(),
          reset: z.boolean().optional(),
          listAll: z.boolean().optional(),
        })
        .parse(args || {})

      const state = await readState()
      const interval = input.interval || DEFAULTS.interval

      if (input.listAll) {
        return JSON.stringify({ path: state.path, stateFile: state.data, note: state.note })
      }
      if (!input.tokenAddress) {
        return JSON.stringify({ error: 'Pass tokenAddress (and optionally interval), or listAll: true.', path: state.path })
      }

      const key = stateKey(input.chainId, input.tokenAddress, interval)

      if (input.reset) {
        delete state.data.positions[key]
        const written = await writeState(state.data)
        if (!written.ok) {
          return JSON.stringify({ error: `Could not write position state: ${written.error}`, path: written.path })
        }
        return JSON.stringify({ reset: true, key, path: written.path, state: { state: 'flat' } })
      }

      return JSON.stringify({
        key,
        path: state.path,
        state: state.data.positions[key] || { state: 'flat' },
        note: state.note,
      })
    },
  })

  /* ---------------- tool 3: backtest ---------------- */

  pi.registerTool({
    name: 'macd_backtest',
    description:
      'Simulate the MACD pullback algorithm over the supplied OHLCV bars and return a balance time series, the final balance, the ratio as a percentage of the original balance, and the trade list. Requires at least 200 candles. Never quotes and never creates a sign request.',
    parameters: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'EVM chain id (used only for the Uniswap V4 candle fetch)' },
        tokenAddress: { type: 'string', description: 'Token contract address (0x…)' },
        interval: { type: 'string', description: 'Candle interval. Default 4h' },
        lookbackDays: { type: 'number', description: 'Candle lookback in days. Default 60. Ignored as the window length when candleCount is set; the fetch is then long enough for that many bars.' },
        candleCount: { type: 'number', description: 'Use the last this many candles. 4h and 200 keeps 200 four-hour bars. Backtest minimum 200.' },
        dataSource: { type: 'string', description: "uniswap-v4 (default). The plugin fetches full Uniswap V4 candles. Do not pass a chart-tool summary." },
        candles: { type: 'array', items: { type: 'object' }, description: 'OHLCV bars when dataSource=provided, oldest first' },
        poolReference: { type: 'string', description: 'Optional Uniswap V4 bytes32 pool id. Omit it and pass tokenAddress to try standard USDC fee tiers.' },
        existingPool: { type: 'object', description: '{ token0Address, token1Address, fee?, tickSpacing?, hooks? }' },
        pullbackBars: { type: 'number', description: 'Default 2' },
        percentOfBalance: { type: 'number', description: 'Percent of the USDC balance per buy. Default 50' },
        initialBalanceUsdc: { type: 'string', description: 'Starting balance for the simulation. Default 1000' },
        feeBps: { type: 'number', description: 'Fee applied to each simulated swap, in basis points. Default 30' },
        maxSeriesPoints: { type: 'number', description: 'Downsample the balance series to at most this many points. Default 400' },
      },
      required: ['chainId'],
    },
    async execute(args) {
      const input = z
        .object({
          chainId: z.number().int().positive(),
          tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
          interval: z.enum(INTERVALS).optional(),
          lookbackDays: z.number().positive().max(2000).optional(),
          candleCount: z.number().int().min(1).max(2000).optional(),
          symbol: z.string().optional(),
          dataSource: z.enum(['uniswap-v4', 'provided']).optional(),
          candles: z.array(candleSchema).optional(),
          poolReference: z.string().optional(),
          existingPool: z
            .object({
              token0Address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
              token1Address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
              poolReference: z.string().optional(),
              fee: z.union([z.string(), z.number()]).optional(),
              tickSpacing: z.union([z.string(), z.number()]).optional(),
              hooks: z.string().optional(),
            })
            .optional(),
          pullbackBars: z.number().int().min(1).max(50).optional(),
          percentOfBalance: z.number().min(1).max(100).optional(),
          initialBalanceUsdc: z.union([z.string(), z.number()]).optional(),
          feeBps: z.number().min(0).max(1000).optional(),
          maxSeriesPoints: z.number().int().min(10).max(5000).optional(),
        })
        .parse(args || {})

      const interval = input.interval || DEFAULTS.interval
      const pullbackBars = input.pullbackBars ?? DEFAULTS.pullbackBars
      const percentOfBalance = input.percentOfBalance ?? DEFAULTS.percentOfBalance
      const initialBalanceUsdc = String(input.initialBalanceUsdc ?? DEFAULTS.initialBalanceUsdc)
      const feeBps = input.feeBps ?? DEFAULTS.feeBps
      const loaded = await loadBars(input, DEFAULTS.minBacktestCandles)
      if (loaded.error) return JSON.stringify(loaded)
      const lookbackDays = loaded.lookbackDays
      const candleCount = loaded.candleCount ?? null
      const bars = loaded.bars
      const dataSource = loaded.dataSource

      let series
      let calc
      try {
        calc = await computeMacd(bars)
        series = calc.series
      } catch (err) {
        return JSON.stringify({ error: `MACD calculation failed: ${err?.message || String(err)}` })
      }
      if (!series) {
        return JSON.stringify({
          error: calc?.reason ? 'MACD calculation failed.' : 'Could not read the MACD result shape.',
          ...(calc?.reason ? { reason: calc.reason } : {}),
        })
      }

      const result = runBacktest(bars, series, {
        percentOfBalance,
        pullbackBars,
        feeBps,
        initialBalanceUsdc,
      })

      const maxPoints = input.maxSeriesPoints ?? 400
      let balanceSeries = result.balanceSeries
      let downsampled = false
      if (balanceSeries.length > maxPoints) {
        const step = Math.ceil(balanceSeries.length / maxPoints)
        const out = []
        for (let i = 0; i < balanceSeries.length; i += step) out.push(balanceSeries[i])
        if (out[out.length - 1] !== balanceSeries[balanceSeries.length - 1]) {
          out.push(balanceSeries[balanceSeries.length - 1])
        }
        balanceSeries = out
        downsampled = true
      }

      return JSON.stringify({
        mode: 'backtest',
        dryRun: true,
        signRequestCreated: false,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress || null,
        symbol: input.symbol || null,
        interval,
        lookbackDays,
        candleCount,
        dataSource,
        poolReference: loaded.poolReference || input.poolReference || null,
        fee: loaded.fee ?? null,
        priceUnit: loaded.priceUnit || null,
        priceInverted: Boolean(loaded.priceInverted),
        ...(loaded.priceUnit === 'usdc-per-token'
          ? { firstCloseUsdc: result.firstClose, lastCloseUsdc: result.lastClose }
          : {}),
        bars: bars.length,
        macdOffset: macdOffset(bars, series),
        pullbackBars,
        percentOfBalance,
        feeBps,
        ...result,
        balanceSeries,
        balanceSeriesDownsampled: downsampled,
        balanceSeriesPoints: balanceSeries.length,
        assumptions: [
          'Closes are USDC per token. buyAndHoldPct is the change in the USDC value of tokens bought with the starting USDC at the first MACD bar and held to the last bar. A positive percentage means that USDC value increased. pctProfit is the change in the simulated USDC balance.',
          'Buys spend percentOfBalance of the current USDC balance; sells close the whole token position.',
          'A long position suppresses further buys until a Bearish Entry closes it (same rule as the live tool).',
          `feeBps=${feeBps} is deducted from each simulated swap notional.`,
          'Candle-close execution only; no intrabar fills, no slippage model, no gas.',
        ],
      })
    },
  })

  /* ---------------- tool 4: entry order ---------------- */

  pi.registerTool({
    name: 'macd_entry_order',
    description:
      'Fetch or accept OHLCV bars, evaluate the MACD 12/26/9 pullback rule, honour stored position state, size the order and quote Uniswap V4. Dry run by default: returns the decision and the quote only. With dryRun:false it re-quotes immediately before returning and hands back an UNSIGNED payload for the agent to put into a multi-sign request. Never signs, never broadcasts.',
    parameters: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'EVM chain id, decimal (e.g. 8453 Base)' },
        tokenAddress: { type: 'string', description: 'Token contract address from get_token_registry (0x…)' },
        symbol: { type: 'string', description: 'Ticker for the purpose text' },
        tokenDecimals: { type: 'number', description: 'Default 18' },
        interval: { type: 'string', description: '5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|1w. Default 4h' },
        lookbackDays: { type: 'number', description: 'Candle lookback in days. Default 60. When candleCount is set, the fetch covers that many bars instead.' },
        candleCount: { type: 'number', description: 'Use the last this many candles. 4h and 200 keeps 200 four-hour bars. Entry minimum 100.' },
        dataSource: { type: 'string', description: 'uniswap-v4 (default). The plugin fetches full Uniswap V4 candles. Do not pass a chart-tool summary.' },
        candles: { type: 'array', items: { type: 'object' }, description: 'OHLCV bars when dataSource=provided, oldest first' },
        poolReference: { type: 'string', description: 'Optional Uniswap V4 bytes32 pool id. Omit it and pass tokenAddress to try standard USDC fee tiers.' },
        existingPool: { type: 'object', description: '{ token0Address, token1Address, poolReference?, fee?, tickSpacing?, hooks? }' },
        pullbackBars: { type: 'number', description: 'Bars the MACD line must hold below/above zero before the cross counts. Default 2' },
        crossLookback: { type: 'number', description: 'Bars back a cross still counts. Default 0' },
        percentOfBalance: { type: 'number', description: 'Percent of the input-asset balance. Default 50' },
        amountHuman: { type: 'string', description: 'Explicit input amount in human units; overrides percentOfBalance' },
        balanceHuman: { type: 'string', description: 'Input-asset balance in human units, supplied by the agent' },
        rpcUrl: { type: 'string', description: 'Optional RPC to read balanceOf when balanceHuman is omitted' },
        usdcAddress: { type: 'string', description: 'Override USDC; defaults per chain' },
        slippage: { type: 'number', description: 'Slippage percent; omit for API auto' },
        dryRun: { type: 'boolean', description: 'Default true. false returns an unsigned payload and writes position state.' },
      },
      required: ['chainId', 'tokenAddress'],
    },
    async execute(args) {
      const input = z
        .object({
          chainId: z.number().int().positive(),
          tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'tokenAddress must be a 0x address'),
          symbol: z.string().optional(),
          tokenDecimals: z.number().int().min(0).max(36).optional(),
          interval: z.enum(INTERVALS).optional(),
          lookbackDays: z.number().positive().max(2000).optional(),
          candleCount: z.number().int().min(1).max(2000).optional(),
          dataSource: z.enum(['uniswap-v4', 'provided']).optional(),
          candles: z.array(candleSchema).optional(),
          poolReference: z.string().optional(),
          existingPool: z
            .object({
              token0Address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
              token1Address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
              poolReference: z.string().optional(),
              fee: z.union([z.string(), z.number()]).optional(),
              tickSpacing: z.union([z.string(), z.number()]).optional(),
              hooks: z.string().optional(),
            })
            .optional(),
          pullbackBars: z.number().int().min(1).max(50).optional(),
          crossLookback: z.number().int().min(0).max(20).optional(),
          percentOfBalance: z.number().min(1).max(100).optional(),
          amountHuman: z.union([z.string(), z.number()]).optional(),
          balanceHuman: z.union([z.string(), z.number()]).optional(),
          rpcUrl: z.string().url().optional(),
          usdcAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
          slippage: z.number().min(0).max(50).optional(),
          dryRun: z.boolean().optional(),
        })
        .parse(args || {})

      const dryRun = input.dryRun !== false
      const interval = input.interval || DEFAULTS.interval
      const pullbackBars = input.pullbackBars ?? DEFAULTS.pullbackBars
      const percentOfBalance = input.percentOfBalance ?? DEFAULTS.percentOfBalance
      const tokenDecimals = input.tokenDecimals ?? DEFAULTS.tokenDecimals
      const tokenAddress = input.tokenAddress
      const symbol = input.symbol || `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`
      const usdcAddress = resolveUsdc(input.chainId, input.usdcAddress)
      if (!usdcAddress) {
        return JSON.stringify({ error: `No default USDC address for chainId ${input.chainId}. Pass usdcAddress explicitly.` })
      }
      if (!pi.variableConfigured('UNISWAP_API_KEY')) {
        return JSON.stringify({
          error:
            'UNISWAP_API_KEY is not configured on this node. Add it in Variables — Uniswap Trade API quotes need it. Nothing was quoted and no payload was built.',
        })
      }

      const address = pi.preferredKeyGenAddress()

      /* 1. bars */
      const loaded = await loadBars(input, DEFAULTS.minCandles)
      if (loaded.error) return JSON.stringify(loaded)
      const bars = loaded.bars
      const dataSource = loaded.dataSource
      const lookbackDays = loaded.lookbackDays
      const candleCount = loaded.candleCount ?? null

      /* 2. signal */
      let series
      let calc
      try {
        calc = await computeMacd(bars)
        series = calc.series
      } catch (err) {
        return JSON.stringify({ error: `MACD calculation failed: ${err?.message || String(err)}` })
      }
      if (!series) {
        return JSON.stringify({
          error: calc?.reason ? 'MACD calculation failed.' : 'Could not read the MACD result shape.',
          ...(calc?.reason ? { reason: calc.reason } : {}),
        })
      }

      const verdict = evaluateLatest(series, pullbackBars, input.crossLookback ?? 0)
      const signalBlock = {
        indicator: 'MACD(12,26,9)',
        interval,
        bars: bars.length,
        pullbackBars,
        ...verdict,
        action: verdict.action || 'none',
      }

      /* 3. position state */
      const key = stateKey(input.chainId, tokenAddress, interval)
      const state = await readState()
      const stored = state.data.positions[key] || { state: 'flat' }
      const isLong = stored.state === 'long'

      let action = verdict.action || 'none'
      let blocked = null
      if (action === 'buy' && isLong) {
        blocked = 'Already long — a repeat buy is suppressed until a Bearish Entry closes the position.'
        action = 'none'
      } else if (action === 'sell' && !isLong) {
        blocked = 'Bearish Entry but the stored state is flat — there is no token position to sell.'
        action = 'none'
      }

      const base = {
        chainId: input.chainId,
        tokenAddress,
        symbol,
        interval,
        lookbackDays,
        candleCount,
        dataSource,
        poolReference: loaded.poolReference || input.poolReference || null,
        fee: loaded.fee ?? null,
        bars: bars.length,
        pullbackBars,
        dryRun,
        position: { key, state: stored.state, isLong, source: state.path, note: state.note },
        signal: signalBlock,
        blocked,
      }

      if (action === 'none') {
        return JSON.stringify({
          ...base,
          decision: 'no-trade',
          signRequestCreated: false,
          unsignedPayload: null,
          message: blocked || verdict.reason || 'No MACD entry on this bar. Nothing was quoted.',
        })
      }

      const side = action

      /* 4. size */
      let inputHuman
      const tokenIn = side === 'buy' ? usdcAddress : tokenAddress
      const tokenOut = side === 'buy' ? tokenAddress : usdcAddress
      const inDecimals = side === 'buy' ? 6 : tokenDecimals

      if (input.amountHuman !== undefined) {
        inputHuman = String(input.amountHuman)
      } else {
        let balanceHuman = input.balanceHuman !== undefined ? num(input.balanceHuman) : null
        if (balanceHuman === null || !Number.isFinite(balanceHuman)) {
          if (!input.rpcUrl) {
            return JSON.stringify({
              ...base,
              decision: 'error',
              error:
                'percentOfBalance needs balanceHuman (from agent_get_balance) or an rpcUrl to read the balance. Nothing was quoted.',
            })
          }
          try {
            const provider = new JsonRpcProvider(input.rpcUrl)
            const erc20 = new Contract(tokenIn, ERC20_ABI, provider)
            const rawBal = await erc20.balanceOf(address)
            const dec = side === 'buy' ? 6 : Number(await erc20.decimals())
            balanceHuman = Number(rawBal) / 10 ** dec
          } catch (err) {
            return JSON.stringify({ ...base, decision: 'error', error: `Balance read failed: ${err?.message || String(err)}` })
          }
        }
        if (!Number.isFinite(balanceHuman) || balanceHuman <= 0) {
          return JSON.stringify({ ...base, decision: 'error', error: 'Input-asset balance is zero or unreadable; nothing to trade.' })
        }
        const sized = (balanceHuman * percentOfBalance) / 100
        inputHuman = sized.toFixed(side === 'buy' ? 6 : Math.min(tokenDecimals, 8))
      }

      const amountWei = toBaseUnits(inputHuman, inDecimals)
      if (amountWei === '0') {
        return JSON.stringify({ ...base, decision: 'error', error: `Sized amount ${inputHuman} rounds to zero base units.` })
      }

      /* 5. quote */
      let built
      try {
        built = await buildSwap(uni, {
          chainId: input.chainId,
          tokenIn,
          tokenOut,
          amountWei,
          slippage: input.slippage,
          swapper: address,
        })
      } catch (err) {
        return JSON.stringify({ ...base, decision: 'error', error: `Uniswap quote failed: ${err?.message || String(err)}` })
      }

      let tx = built.swap?.swap
      if (!tx || !isAddress(tx.to) || !tx.data) {
        return JSON.stringify({ ...base, decision: 'error', error: 'Uniswap returned no usable swap transaction.' })
      }

      const purpose =
        `${verdict.entryLabel || (side === 'buy' ? 'Bullish Entry' : 'Bearish Entry')} MACD(12,26,9) ${interval}: ` +
        `MACD ${Number(verdict.macd).toFixed(6)} vs signal ${Number(verdict.signal).toFixed(6)} ` +
        `(cross ${verdict.cross}, zero line ${verdict.zeroLine}, ${verdict.zeroBars} bar(s) beyond zero, ${verdict.barsSinceCross} bar(s) since cross). ` +
        (side === 'buy'
          ? `Buy ${symbol} with ${inputHuman} USDC`
          : `Sell ${inputHuman} ${symbol} for USDC`) +
        ` on chain ${input.chainId} via Uniswap Universal Router (${percentOfBalance}% of balance).`

      /* 6. dry run stops here */
      if (dryRun) {
        return JSON.stringify({
          ...base,
          decision: 'would-trade',
          side,
          entry: verdict.entry || (side === 'buy' ? 'bullish' : 'bearish'),
          pair: { tokenIn: side === 'buy' ? 'USDC' : symbol, tokenOut: side === 'buy' ? symbol : 'USDC', usdcAddress },
          amountInHuman: inputHuman,
          amountInWei: amountWei,
          quote: { amountOut: quoteOutAmount(built.quoteJson), slippage: input.slippage ?? 'auto' },
          previewSwap: { to: tx.to, value: tx.value ? String(tx.value) : '0' },
          purposePreview: purpose,
          signRequestCreated: false,
          unsignedPayload: null,
          message:
            'Dry run: nothing was signed, no payload was returned and position state was not changed. Re-run with dryRun:false to build the unsigned payload.',
        })
      }

      /* 7. real run: re-quote immediately before returning the payload */
      try {
        built = await buildSwap(uni, {
          chainId: input.chainId,
          tokenIn,
          tokenOut,
          amountWei,
          slippage: input.slippage,
          swapper: address,
        })
      } catch (err) {
        return JSON.stringify({
          ...base,
          decision: 'error',
          error: `Re-quote before returning the payload failed: ${err?.message || String(err)}. Nothing was returned.`,
        })
      }

      tx = built.swap?.swap
      if (!tx || !isAddress(tx.to) || !tx.data) {
        return JSON.stringify({ ...base, decision: 'error', error: 'The fresh Uniswap quote returned no usable swap transaction.' })
      }

      /* 8. persist state BEFORE returning the payload, so a repeat buy cannot slip through */
      const nextPositions = { ...(state.data.positions || {}) }
      if (side === 'buy') {
        nextPositions[key] = {
          state: 'long',
          entryAt: new Date().toISOString(),
          entryAmountInHuman: inputHuman,
          entrySignal: {
            macd: verdict.macd,
            signal: verdict.signal,
            zeroBars: verdict.zeroBars,
            interval,
          },
        }
      } else {
        nextPositions[key] = {
          state: 'flat',
          exitedAt: new Date().toISOString(),
          exitAmountInHuman: inputHuman,
          exitSignal: { macd: verdict.macd, signal: verdict.signal, interval },
        }
      }
      const written = await writeState({ version: 1, positions: nextPositions })
      if (!written.ok) {
        return JSON.stringify({
          ...base,
          decision: 'error',
          error: `Could not persist position state (${written.error}). Refusing to return a payload, because a repeated buy could not be suppressed.`,
        })
      }

      return JSON.stringify({
        ...base,
        decision: 'trade',
        side,
        entry: verdict.entry || (side === 'buy' ? 'bullish' : 'bearish'),
        pair: { tokenIn: side === 'buy' ? 'USDC' : symbol, tokenOut: side === 'buy' ? symbol : 'USDC', usdcAddress },
        amountInHuman: inputHuman,
        amountInWei: amountWei,
        quotedAt: new Date().toISOString(),
        quote: { amountOut: quoteOutAmount(built.quoteJson), slippage: input.slippage ?? 'auto' },
        unsignedPayload: {
          chainId: input.chainId,
          to: tx.to,
          data: tx.data,
          value: tx.value ? String(tx.value) : '0',
          purpose,
        },
        positionAfter: { key, state: nextPositions[key].state, path: written.path },
        signRequestCreated: false,
        nextStep:
          'The agent opens the multi-sign request with unsignedPayload (chainId, to, data, value, purpose). This plugin never signs and never broadcasts.',
      })
    },
  })
}
