// One POST /api/kline/daily-batch, then GET /api/kline/daily for every symbol
// the batch left without a quote, and for every symbol whose selected raw is
// older than a later real bar on or before asOf. Future bars are not that
// date target. A failed GET leaves only that symbol unavailable and does not
// keep the older raw. qfq `close` is never a raw price. This cache stores a
// fully cacheable merged result. GET hits also stay in the fallback cache for
// 60s. Any non-cacheable GET is not stored here, so a later call can recover
// that symbol without dropping the others.
// No store.
import { createDailyQuoteFallback } from './daily-quote-fallback.js';
import { selectDailyQuote } from './daily-quotes.js';

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 128;

function dedupeSymbols(symbols) {
  const seen = new Set();
  const unique = [];
  for (const symbol of symbols) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  return unique;
}

// asOf plus sorted deduped symbols. Request body order stays first-seen.
function quoteCacheKey(symbols, asOf) {
  const sorted = symbols.slice().sort();
  return `${JSON.stringify(asOf)}\0${JSON.stringify(sorted)}`;
}

function isAbortError(err, signal) {
  if (signal && signal.aborted) return true;
  return !!err && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function abortError() {
  const err = new Error('timeout');
  err.name = 'AbortError';
  return err;
}

// reason/status/count only. Never the response body or the full URL.
function logFailure(logger, reason, status, count) {
  if (!logger || typeof logger.warn !== 'function') return;
  logger.warn({ reason, status, count });
}

// Timeout covers both the POST and response.json().
function withAbort(work, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
  });
}

function barsBySymbol(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

function copyQuotes(quotes) {
  return new Map(quotes);
}

// Newest real bar date on or before asOf. The synthetic raw_close is only a
// probe so selectDailyQuote applies its calendar-day and future-date rules.
// The probe price is never returned as a quote.
function latestRealBarDate(rows, asOf) {
  if (!Array.isArray(rows)) return null;
  const probed = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    probed.push({ date: row.date, raw_close: '1' });
  }
  const marker = selectDailyQuote(probed, asOf);
  return marker ? marker.price_as_of : null;
}

// GET when the batch has no usable raw, or when a newer calendar bar on or
// before asOf has no raw. Future rows cannot move this date.
function needsDailyLookup(rows, asOf, quote) {
  if (!quote) return true;
  const latest = latestRealBarDate(rows, asOf);
  return latest !== null && latest > quote.price_as_of;
}

export function createDailyQuoteProvider({
  baseUrl = process.env.TSP_MARKET_BASE_URL || 'http://127.0.0.1:3018',
  fetchImpl = fetch,
  logger = console,
  timeoutMs = 3000,
  now = Date.now,
} = {}) {
  const root = String(baseUrl || 'http://127.0.0.1:3018').replace(/\/+$/, '');
  const endpoint = `${root}/api/kline/daily-batch`;
  const cache = new Map();
  const inflight = new Map();
  const fallbackDailyQuotes = createDailyQuoteFallback({
    baseUrl: root,
    fetchImpl,
    logger,
    timeoutMs,
    now,
  });

  function pruneCache(at) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(key);
    }
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function remember(key, quotes) {
    const storedAt = now();
    const stored = copyQuotes(quotes);
    pruneCache(storedAt);
    cache.delete(key);
    cache.set(key, { expiresAt: storedAt + CACHE_TTL_MS, quotes: stored });
    pruneCache(storedAt);
    return stored;
  }

  // Failures return a Map and must not be stored. Only a parsed payload is cacheable.
  async function requestDailyQuotes(unique, asOf) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await withAbort(
          () => fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({ symbols: unique, days: 5 }),
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (err) {
        const reason = isAbortError(err, controller.signal) ? 'timeout' : 'network';
        logFailure(logger, reason, null, unique.length);
        return { cacheable: false, quotes: new Map() };
      }

      if (!response || response.ok !== true) {
        logFailure(logger, 'http', response ? response.status : null, unique.length);
        // Drop the unread error body before finally clears the deadline timer.
        if (response) controller.abort();
        return { cacheable: false, quotes: new Map() };
      }

      let payload;
      try {
        payload = await withAbort(() => response.json(), controller.signal);
      } catch (err) {
        const reason = isAbortError(err, controller.signal) ? 'timeout' : 'json';
        logFailure(logger, reason, response.status, unique.length);
        return { cacheable: false, quotes: new Map() };
      }

      const data = barsBySymbol(payload);
      if (!data) {
        logFailure(logger, 'bad_shape', response.status, unique.length);
        return { cacheable: false, quotes: new Map() };
      }

      // selectDailyQuote still chooses the raw price and its real date.
      // selected keeps only symbols that already cover the newest <= asOf bar.
      // An older raw is a lookup, not a result: a failed GET must not put it back.
      // Other symbols stay on their batch quotes.
      const selected = new Map();
      const missing = [];
      for (const symbol of unique) {
        const rows = data[symbol];
        const quote = selectDailyQuote(rows, asOf);
        if (!needsDailyLookup(rows, asOf, quote)) {
          selected.set(symbol, quote);
          continue;
        }
        missing.push(symbol);
      }
      if (missing.length === 0) return { cacheable: true, quotes: selected };

      const outcomes = await fallbackDailyQuotes(missing, asOf);
      const quotes = new Map();
      let cacheable = true;
      for (const symbol of unique) {
        if (selected.has(symbol)) {
          quotes.set(symbol, selected.get(symbol));
          continue;
        }
        const outcome = outcomes.get(symbol);
        if (!outcome || outcome.cacheable !== true) cacheable = false;
        if (outcome && outcome.quote) quotes.set(symbol, outcome.quote);
      }
      return { cacheable, quotes };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function dailyQuotes(symbols, asOf) {
    if (!Array.isArray(symbols) || symbols.length === 0) return new Map();

    const unique = dedupeSymbols(symbols);
    if (unique.length === 0) return new Map();

    const key = quoteCacheKey(unique, asOf);
    pruneCache(now());
    const hit = cache.get(key);
    if (hit) return copyQuotes(hit.quotes);

    const pending = inflight.get(key);
    if (pending) return copyQuotes(await pending);

    const job = requestDailyQuotes(unique, asOf).then((result) => {
      if (!result.cacheable) return result.quotes;
      return remember(key, result.quotes);
    });
    inflight.set(key, job);
    try {
      return copyQuotes(await job);
    } finally {
      inflight.delete(key);
    }
  };
}
