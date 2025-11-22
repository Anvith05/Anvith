// Frontend logic: calls backend /api/scan for each pair

const PAIRS = [
  { symbol: 'BTC/USD', label: 'BTCUSD' },
  { symbol: 'EUR/AUD', label: 'EURAUD' },
  { symbol: 'EUR/GBP', label: 'EURGBP' },
  { symbol: 'GBP/JPY', label: 'GBPJPY' },
  { symbol: 'GBP/USD', label: 'GBPUSD' },
  { symbol: 'AUD/NZD', label: 'AUDNZD' },
  { symbol: 'CHF/JPY', label: 'CHFJPY' },
  { symbol: 'NZD/USD', label: 'NZDUSD' },
];

let pollingTimer = null;

function $(selector) {
  return document.querySelector(selector);
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDateTime(date) {
  return date.toLocaleString(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTableRows() {
  const tbody = document.querySelector('#pairsTable tbody');
  tbody.innerHTML = '';
  PAIRS.forEach((pair) => {
    const tr = document.createElement('tr');
    tr.dataset.symbol = pair.symbol;

    tr.appendChild(createEl('td', null, pair.label));
    tr.appendChild(createEl('td', 'price-cell', '-'));
    tr.appendChild(createEl('td', 'signal-cell', '-'));
    tr.appendChild(createEl('td', 'pattern-cell', '-'));
    tr.appendChild(createEl('td', 'pattern-window-cell', '-'));
    tr.appendChild(createEl('td', 'tf-cell', '-'));
    tr.appendChild(createEl('td', 'confluence-cell', '-'));
    tr.appendChild(createEl('td', 'time-cell', '-'));

    tbody.appendChild(tr);
  });
}

function updateRow(symbol, data) {
  const row = document.querySelector(`tr[data-symbol="${symbol}"]`);
  if (!row) return;

  const priceCell = row.querySelector('.price-cell');
  const signalCell = row.querySelector('.signal-cell');
  const patternCell = row.querySelector('.pattern-cell');
  const patternWindowCell = row.querySelector('.pattern-window-cell');
  const tfCell = row.querySelector('.tf-cell');
  const confCell = row.querySelector('.confluence-cell');
  const timeCell = row.querySelector('.time-cell');

  if (typeof data.lastClose === 'number' && !Number.isNaN(data.lastClose)) {
    priceCell.textContent = data.lastClose
      .toFixed(5)
      .replace(/0+$/, '')
      .replace(/\.$/, '');
    priceCell.className = 'price-cell';
    if (data.signal?.direction === 'bullish') priceCell.classList.add('price-positive');
    if (data.signal?.direction === 'bearish') priceCell.classList.add('price-negative');
  } else {
    priceCell.textContent = '-';
    priceCell.className = 'price-cell';
  }

  const badge = (text, type) => {
    const span = document.createElement('span');
    span.textContent = text;
    span.className = `badge ${type}`;
    return span;
  };

  signalCell.innerHTML = '';
  patternCell.textContent = data.signal?.pattern ?? '-';
  tfCell.textContent = data.signal?.timeframe ?? '-';

  if (data.signal?.direction === 'bullish') {
    signalCell.appendChild(badge('Bullish', 'badge-bullish'));
  } else if (data.signal?.direction === 'bearish') {
    signalCell.appendChild(badge('Bearish', 'badge-bearish'));
  } else if (data.error) {
    signalCell.appendChild(badge('Error', 'badge-neutral'));
  } else {
    signalCell.appendChild(badge('No signal', 'badge-neutral'));
  }

  confCell.innerHTML = '';
  const normalizeTrend = (t) => (t === 'weak' ? 'sideways' : t || 'N/A');
  const dayRaw = data.dayTrend;
  const weekRaw = data.weekTrend;
  const dayLabel = normalizeTrend(dayRaw);
  const weekLabel = normalizeTrend(weekRaw);

  confCell.appendChild(
    badge(
      `D: ${dayLabel}`,
      dayRaw === 'bullish' ? 'badge-bullish' : dayRaw === 'bearish' ? 'badge-bearish' : 'badge-weak'
    )
  );
  confCell.appendChild(document.createTextNode(' / '));
  confCell.appendChild(
    badge(
      `W: ${weekLabel}`,
      weekRaw === 'bullish' ? 'badge-bullish' : weekRaw === 'bearish' ? 'badge-bearish' : 'badge-weak'
    )
  );

  if (patternWindowCell) {
    if (data.signal?.from && data.signal?.to) {
      const from = new Date(data.signal.from);
      const to = new Date(data.signal.to);
      patternWindowCell.textContent = `${formatDateTime(from)} → ${formatDateTime(to)}`;
    } else {
      patternWindowCell.textContent = '-';
    }
  }

  if (data.updatedAt && timeCell) {
    timeCell.textContent = formatTime(data.updatedAt);
  }
}

function logSignal(symbolLabel, signal) {
  if (!signal) return;
  const log = $('#signalLog');
  const li = document.createElement('li');
  const now = new Date();
  li.textContent = `${now.toLocaleString()} - ${symbolLabel} - ${signal.direction.toUpperCase()} ${signal.pattern} on ${signal.timeframe}`;
  log.appendChild(li);
}

async function loadHistory() {
  const list = $('#historyLog');
  if (!list) return;
  try {
    const res = await fetch('/api/signals?limit=100');
    if (!res.ok) return;
    const items = await res.json();
    list.innerHTML = '';
    items.forEach((s) => {
      const li = document.createElement('li');
      const t = new Date(s.createdAt);
      li.textContent = `${t.toLocaleString()} - ${s.symbol} - ${s.direction.toUpperCase()} ${s.pattern} on ${s.timeframe} @ ${s.price}`;
      list.appendChild(li);
    });
  } catch (e) {
    console.error('Failed to load history', e);
  }
}

async function scanPair(pair) {
  try {
    const res = await fetch(`/api/scan?symbol=${encodeURIComponent(pair.symbol)}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();

    const uiData = {
      lastClose: json.lastClose,
      dayTrend: json.dayTrend,
      weekTrend: json.weekTrend,
      signal: json.signal || null,
      updatedAt: new Date(),
    };

    updateRow(pair.symbol, uiData);
    if (json.signal) {
      logSignal(pair.label, json.signal);
      // Refresh MongoDB-backed history when a new signal is created
      loadHistory();
    }
  } catch (err) {
    console.error('Error scanning', pair.symbol, err);
    updateRow(pair.symbol, {
      lastClose: NaN,
      dayTrend: 'error',
      weekTrend: 'error',
      signal: null,
      error: true,
      updatedAt: new Date(),
    });
  }
}

async function runScanLoop() {
  // Enforce a minimum of 1 hour between full scans to stay well under daily limits.
  const MIN_REFRESH_SEC = 3600; // 1 hour
  const refreshSec = Math.max(MIN_REFRESH_SEC, Number($('#refreshInterval').value) || MIN_REFRESH_SEC);
  $('#status').textContent = `Running every ${refreshSec}s`;
  $('#startBtn').disabled = true;
  $('#stopBtn').disabled = false;

  const DELAY_BETWEEN_PAIRS_MS = 60000; // 60s; ~1 symbol/min -> ~4 Twelve Data requests/min

  const tick = async () => {
    for (const pair of PAIRS) {
      await scanPair(pair);
      // Throttle between pairs to avoid hitting Twelve Data per-minute credit limits
      await sleep(DELAY_BETWEEN_PAIRS_MS);
    }
  };

  await tick();
  pollingTimer = setInterval(tick, refreshSec * 1000);
}

function stopScanLoop() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  $('#status').textContent = 'Stopped';
  $('#startBtn').disabled = false;
  $('#stopBtn').disabled = true;
}

// Init

document.addEventListener('DOMContentLoaded', () => {
  ensureTableRows();
  loadHistory();

  $('#startBtn').addEventListener('click', () => {
    if (!pollingTimer) runScanLoop();
  });

  $('#stopBtn').addEventListener('click', () => {
    stopScanLoop();
  });
});
