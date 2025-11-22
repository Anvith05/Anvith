require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const rawPort = process.env.PORT || '4000';
const PORT = Number.parseInt(rawPort, 10);

if (!Number.isFinite(PORT)) {
  console.error(`Invalid PORT value "${rawPort}". Use a numeric port, e.g. 4000.`);
  process.exit(1);
}
// ============================
// MongoDB setup
// ============================

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.warn('MONGODB_URI is not set. Signals will not be stored.');
} else {
  mongoose
    .connect(mongoUri)
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.error('MongoDB connection error', err));
}

const signalSchema = new mongoose.Schema(
  {
    symbol: String,
    direction: String,
    pattern: String,
    timeframe: String,
    dayTrend: String,
    weekTrend: String,
    price: Number,
    patternFrom: Date,
    patternTo: Date,
  },
  { timestamps: true }
);

const Signal = mongoose.models.Signal || mongoose.model('Signal', signalSchema);

// ============================
// External API (Twelve Data)
// ============================

const TD_BASE_URL = 'https://api.twelvedata.com';
const TD_API_KEY = process.env.TWELVE_DATA_API_KEY;

if (!TD_API_KEY) {
  console.error(
    'TWELVE_DATA_API_KEY is not set. Set it in a .env file (see .env.example) before starting the server.'
  );
  process.exit(1);
}
const PATTERN_TIMEFRAMES = [
  { key: '1h', interval: '1h' },
  { key: '4h', interval: '4h' },
];

const HTF_DAY = { key: '1d', interval: '1day' };
const HTF_WEEK = { key: '1w', interval: '1week' };

async function fetchSeries(symbol, interval, outputsize = 300) {
  if (!TD_API_KEY) throw new Error('TWELVE_DATA_API_KEY not configured');

  const url = new URL(TD_BASE_URL + '/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', outputsize);
  url.searchParams.set('apikey', TD_API_KEY);

  const res = await axios.get(url.toString());
  if (res.data.status === 'error') {
    // Preserve Twelve Data error message and include symbol/interval for easier debugging
    const msg = res.data.message || 'API error';
    throw new Error(`[TD] ${msg} (symbol=${symbol}, interval=${interval})`);
  }

  const values = res.data.values || [];
  const candles = values
    .map((v) => ({
      time: new Date(v.datetime),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse();

  return candles;
}

// ============================
// Trend + pattern detection
// ============================

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let prevEma = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  result.push(prevEma);
  for (let i = period; i < values.length; i++) {
    prevEma = values[i] * k + prevEma * (1 - k);
    result.push(prevEma);
  }
  return result;
}

function detectTrendHTF(candles) {
  if (!candles || candles.length < 60) {
    return { trend: 'neutral', reason: 'Not enough data' };
  }

  const closes = candles.map((c) => c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  if (ema200.length === 0) {
    return { trend: 'neutral', reason: 'Not enough EMA data' };
  }

  const lastClose = closes[closes.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const lastEma200 = ema200[ema200.length - 1];

  if (lastClose > lastEma50 && lastEma50 > lastEma200) {
    return { trend: 'bullish', reason: 'Close > EMA50 > EMA200' };
  }
  if (lastClose < lastEma50 && lastEma50 < lastEma200) {
    return { trend: 'bearish', reason: 'Close < EMA50 < EMA200' };
  }
  // Neither clearly bullish nor clearly bearish: treat as sideways
  return { trend: 'sideways', reason: 'Mixed EMAs' };
}

function findPivots(candles, lookback = 3) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

function approxEqual(a, b, tolerance = 0.01) {
  const diff = Math.abs(a - b);
  const avg = (Math.abs(a) + Math.abs(b)) / 2 || 1;
  return diff / avg <= tolerance;
}

function detectMTop(candles) {
  const { highs, lows } = findPivots(candles, 2);
  if (highs.length < 2 || lows.length < 1) return null;

  const lastHighs = highs.slice(-4);
  for (let i = lastHighs.length - 2; i >= 1; i--) {
    const h1Idx = lastHighs[i - 1];
    const h2Idx = lastHighs[i];
    const midLows = lows.filter((x) => x > h1Idx && x < h2Idx);
    if (midLows.length === 0) continue;
    const lIdx = midLows[0];

    const h1 = candles[h1Idx].high;
    const h2 = candles[h2Idx].high;
    const low = candles[lIdx].low;

    if (!approxEqual(h1, h2, 0.015)) continue;
    const dropPerc = (Math.max(h1, h2) - low) / Math.max(h1, h2);
    if (dropPerc < 0.01) continue;

    return {
      type: 'M-top',
      indices: { h1Idx, h2Idx, lIdx },
    };
  }
  return null;
}

function detectInvertedM(candles) {
  const { highs, lows } = findPivots(candles, 2);
  if (lows.length < 2 || highs.length < 1) return null;

  const lastLows = lows.slice(-4);
  for (let i = lastLows.length - 2; i >= 1; i--) {
    const l1Idx = lastLows[i - 1];
    const l2Idx = lastLows[i];
    const midHighs = highs.filter((x) => x > l1Idx && x < l2Idx);
    if (midHighs.length === 0) continue;
    const hIdx = midHighs[0];

    const l1 = candles[l1Idx].low;
    const l2 = candles[l2Idx].low;
    const high = candles[hIdx].high;

    if (!approxEqual(l1, l2, 0.015)) continue;
    const risePerc = (high - Math.min(l1, l2)) / Math.min(l1, l2);
    if (risePerc < 0.01) continue;

    return {
      type: 'Inverted M',
      indices: { l1Idx, l2Idx, hIdx },
    };
  }
  return null;
}

function detectHeadAndShoulders(candles) {
  const { highs, lows } = findPivots(candles, 2);
  if (highs.length < 3 || lows.length < 2) return null;

  const lastHighs = highs.slice(-6);
  if (lastHighs.length < 3) return null;

  for (let i = lastHighs.length - 3; i >= 0; i--) {
    const lsIdx = lastHighs[i];
    const headIdx = lastHighs[i + 1];
    const rsIdx = lastHighs[i + 2];

    const ls = candles[lsIdx].high;
    const head = candles[headIdx].high;
    const rs = candles[rsIdx].high;

    if (!(head > ls * 1.01 && head > rs * 1.01)) continue;
    if (!approxEqual(ls, rs, 0.02)) continue;

    const neckLows = lows.filter((x) => x > lsIdx && x < rsIdx);
    if (neckLows.length < 2) continue;
    const n1Idx = neckLows[0];
    const n2Idx = neckLows[neckLows.length - 1];
    const n1 = candles[n1Idx].low;
    const n2 = candles[n2Idx].low;
    if (!approxEqual(n1, n2, 0.02)) continue;

    return {
      type: 'Head & Shoulders',
      indices: { lsIdx, headIdx, rsIdx, n1Idx, n2Idx },
    };
  }
  return null;
}

function detectInverseHeadAndShoulders(candles) {
  const { highs, lows } = findPivots(candles, 2);
  if (lows.length < 3 || highs.length < 2) return null;

  const lastLows = lows.slice(-6);
  if (lastLows.length < 3) return null;

  for (let i = lastLows.length - 3; i >= 0; i--) {
    const lsIdx = lastLows[i];
    const headIdx = lastLows[i + 1];
    const rsIdx = lastLows[i + 2];

    const ls = candles[lsIdx].low;
    const head = candles[headIdx].low;
    const rs = candles[rsIdx].low;

    if (!(head < ls * 0.99 && head < rs * 0.99)) continue;
    if (!approxEqual(ls, rs, 0.02)) continue;

    const neckHighs = highs.filter((x) => x > lsIdx && x < rsIdx);
    if (neckHighs.length < 2) continue;
    const n1Idx = neckHighs[0];
    const n2Idx = neckHighs[neckHighs.length - 1];
    const n1 = candles[n1Idx].high;
    const n2 = candles[n2Idx].high;
    if (!approxEqual(n1, n2, 0.02)) continue;

    return {
      type: 'Inverse Head & Shoulders',
      indices: { lsIdx, headIdx, rsIdx, n1Idx, n2Idx },
    };
  }
  return null;
}

function buildPatternSignal(direction, tfLabel, patternResult, candles) {
  const indices = patternResult.indices || {};
  const indexValues = Object.values(indices).filter((v) => Number.isInteger(v));
  let from = null;
  let to = null;

  if (indexValues.length > 0) {
    const startIdx = Math.min(...indexValues);
    const endIdx = Math.max(...indexValues);
    from = candles[startIdx]?.time || null;
    to = candles[endIdx]?.time || null;
  }

  return {
    direction,
    pattern: patternResult.type,
    timeframe: tfLabel,
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
  };
}

function detectPatternWithConfluence(candles, tfLabel, dayTrend, weekTrend) {
  const mTop = detectMTop(candles);
  const invM = detectInvertedM(candles);
  const hs = detectHeadAndShoulders(candles);
  const invHs = detectInverseHeadAndShoulders(candles);

  const isBearishHTF = dayTrend.trend === 'bearish' && weekTrend.trend === 'bearish';
  const isBullishHTF = dayTrend.trend === 'bullish' && weekTrend.trend === 'bullish';

  if (isBearishHTF && (mTop || hs)) {
    const p = mTop || hs;
    return buildPatternSignal('bearish', tfLabel, p, candles);
  }

  if (isBullishHTF && (invM || invHs)) {
    const p = invM || invHs;
    return buildPatternSignal('bullish', tfLabel, p, candles);
  }

  return null;
}

// ============================
// Express setup
// ============================

app.use(cors());
app.use(express.json());

// Serve static frontend files (index.html, app.js, style.css)
app.use(express.static(__dirname));

// Scan one symbol and optionally store signal
app.get('/api/scan', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol query param is required' });
  }

  try {
    const [day, week] = await Promise.all([
      fetchSeries(symbol, HTF_DAY.interval, 500),
      fetchSeries(symbol, HTF_WEEK.interval, 500),
    ]);

    const dayTrend = detectTrendHTF(day);
    const weekTrend = detectTrendHTF(week);

    let bestSignal = null;
    let lastClose = null;

    for (const tf of PATTERN_TIMEFRAMES) {
      const tfCandles = await fetchSeries(symbol, tf.interval, 400);
      if (tfCandles.length === 0) continue;
      lastClose = tfCandles[tfCandles.length - 1].close;

      const signal = detectPatternWithConfluence(
        tfCandles,
        tf.key,
        dayTrend,
        weekTrend
      );

      if (signal) {
        bestSignal = signal;
        break;
      }
    }

    if (bestSignal && mongoUri) {
      try {
        await Signal.create({
          symbol,
          direction: bestSignal.direction,
          pattern: bestSignal.pattern,
          timeframe: bestSignal.timeframe,
          dayTrend: dayTrend.trend,
          weekTrend: weekTrend.trend,
          price: lastClose,
          patternFrom: bestSignal.from,
          patternTo: bestSignal.to,
        });
      } catch (dbErr) {
        console.error('Failed to store signal', dbErr.message);
      }
    }

    return res.json({
      symbol,
      lastClose,
      dayTrend: dayTrend.trend,
      weekTrend: weekTrend.trend,
      signal: bestSignal,
    });
  } catch (err) {
    // Log more detail so we can see exact Twelve Data / network error
    const extra = err.response?.data || err.stack || err.toString();
    console.error('Scan error', symbol, err.message, extra);
    return res.status(500).json({
      error: err.message || 'Scan failed',
      details: err.response?.data || null,
    });
  }
});

// Simple endpoint to fetch recent signals from MongoDB
app.get('/api/signals', async (req, res) => {
  if (!mongoUri) {
    return res.status(200).json([]);
  }

  const { symbol, limit = 50 } = req.query;
  const query = symbol ? { symbol } : {};

  try {
    const items = await Signal.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit));
    res.json(items);
  } catch (err) {
    console.error('Error fetching signals', err.message);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// Fallback to index.html for root
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
