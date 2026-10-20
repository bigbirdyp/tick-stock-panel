// One POST /api/kline/daily-batch. No cache, no fallback GET, no store.
import { selectDailyQuote } from './daily-quotes.js';

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

export function createDailyQuoteProvider({
  baseUrl = process.env.TSP_MARKET_BASE_URL || 'http://127.0.0.1:3018',
  fetchImpl = fetch,
  logger = console,
  timeoutMs = 3000,
} = {}) {
  const root = String(baseUrl || 'http://127.0.0.1:3018').replace(/\/+$/, '');
  const endpoint = `${root}/api/kline/daily-batch`;

  return async function dailyQuotes(symbols, asOf) {
    if (!Array.isArray(symbols) || symbols.length === 0) return new Map();

    const unique = dedupeSymbols(symbols);
    if (unique.length === 0) return new Map();

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
        return new Map();
      }

      if (!response || response.ok !== true) {
        logFailure(logger, 'http', response ? response.status : null, unique.length);
        return new Map();
      }

      let payload;
      try {
        payload = await withAbort(() => response.json(), controller.signal);
      } catch (err) {
        const reason = isAbortError(err, controller.signal) ? 'timeout' : 'json';
        logFailure(logger, reason, response.status, unique.length);
        return new Map();
      }

      const data = barsBySymbol(payload);
      if (!data) {
        logFailure(logger, 'bad_shape', response.status, unique.length);
        return new Map();
      }

      const quotes = new Map();
      for (const symbol of unique) {
        const quote = selectDailyQuote(data[symbol], asOf);
        if (quote) quotes.set(symbol, quote);
      }
      return quotes;
    } finally {
      clearTimeout(timer);
    }
  };
}
