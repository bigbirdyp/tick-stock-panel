// Per-symbol GET /api/kline/daily. Not wired into the batch provider.
// `close` is forward-adjusted and is never a substitute for `raw_close`.
// `price_status: fresh` means the bar date equals asOf. It does not mean the session has closed.
import { selectDailyQuote } from './daily-quotes.js';

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 128;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 3000;
// The daily route rejects days=5 with 422. 120 is the accepted window; omitting days also defaults to 120.
const LOOKBACK_DAYS = '120';

function dedupeSymbols(symbols) {
  const seen = new Set();
  const unique = [];
  if (!Array.isArray(symbols)) return unique;
  for (const symbol of symbols) {
    if (typeof symbol !== 'string' || symbol.length === 0 || seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  return unique;
}

function cacheKey(symbol, asOf) {
  return `${JSON.stringify(symbol)}\0${JSON.stringify(asOf)}`;
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
  try {
    logger.warn({ reason, status, count });
  } catch {
    // A throwing logger must not fail this symbol or its siblings.
  }
}

// Resolves on abort even when the inner fetch or json() ignores AbortSignal.
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

function copyQuote(quote) {
  if (!quote) return null;
  return {
    price: quote.price,
    price_as_of: quote.price_as_of,
    price_status: quote.price_status,
  };
}

function publish(outcome) {
  return {
    cacheable: outcome.cacheable === true,
    quote: copyQuote(outcome.quote),
  };
}

// Sample shape: { symbol, rows: [{ date, raw_close, close, is_live? }] }.
// end_date on the query is not trusted to drop today's live bar.
function rowsFromPayload(payload, symbol) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.symbol !== symbol || !Array.isArray(payload.rows)) return null;
  return payload.rows;
}

function releaseUnreadBody(response, controller) {
  controller.abort();
  const body = response && response.body;
  if (!body || typeof body.cancel !== 'function') return;
  try {
    const canceling = body.cancel();
    if (canceling && typeof canceling.catch === 'function') canceling.catch(() => {});
  } catch {
    // The unread body is already closed.
  }
}

function resolveConcurrency(value) {
  if (!Number.isInteger(value) || value < 1) return MAX_CONCURRENCY;
  return Math.min(value, MAX_CONCURRENCY);
}

export function createDailyQuoteFallback({
  baseUrl = process.env.TSP_MARKET_BASE_URL || 'http://127.0.0.1:3018',
  fetchImpl = fetch,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = MAX_CONCURRENCY,
  now = Date.now,
} = {}) {
  const root = String(baseUrl || 'http://127.0.0.1:3018').replace(/\/+$/, '');
  const limit = resolveConcurrency(concurrency);
  const cache = new Map();
  const inflight = new Map();
  // GETs share these slots across every fallback() call on this instance.
  // A waiter has not started timeoutMs yet. Cache and inflight never take a slot.
  let activeSlots = 0;
  const slotWaiters = [];

  function acquireSlot() {
    if (activeSlots < limit) {
      activeSlots += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      slotWaiters.push(resolve);
    });
  }

  function releaseSlot() {
    const startNext = slotWaiters.shift();
    if (startNext) {
      startNext();
      return;
    }
    activeSlots -= 1;
  }

  function pruneCache(at) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(key);
    }
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function remember(key, quote) {
    const storedAt = now();
    const stored = copyQuote(quote);
    pruneCache(storedAt);
    cache.delete(key);
    cache.set(key, { expiresAt: storedAt + CACHE_TTL_MS, quote: stored });
    pruneCache(storedAt);
    return stored;
  }

  async function requestOne(symbol, asOf) {
    await acquireSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const params = new URLSearchParams({
      symbol,
      end_date: String(asOf),
      days: LOOKBACK_DAYS,
    });
    const url = `${root}/api/kline/daily?${params.toString()}`;
    try {
      let response;
      try {
        response = await withAbort(
          () => fetchImpl(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (err) {
        const reason = isAbortError(err, controller.signal) ? 'timeout' : 'network';
        logFailure(logger, reason, null, 1);
        return { cacheable: false, quote: null };
      }

      if (!response || response.ok !== true) {
        logFailure(logger, 'http', response ? response.status : null, 1);
        if (response) releaseUnreadBody(response, controller);
        return { cacheable: false, quote: null };
      }

      let payload;
      try {
        payload = await withAbort(() => response.json(), controller.signal);
      } catch (err) {
        const reason = isAbortError(err, controller.signal) ? 'timeout' : 'json';
        logFailure(logger, reason, response.status, 1);
        return { cacheable: false, quote: null };
      }

      const rows = rowsFromPayload(payload, symbol);
      if (!rows) {
        logFailure(logger, 'bad_shape', response.status, 1);
        return { cacheable: false, quote: null };
      }

      // selectDailyQuote keeps date <= asOf and a positive raw_close. is_live does not add a status.
      return { cacheable: true, quote: selectDailyQuote(rows, asOf) };
    } catch (err) {
      const reason = isAbortError(err, controller.signal) ? 'timeout' : 'network';
      logFailure(logger, reason, null, 1);
      return { cacheable: false, quote: null };
    } finally {
      clearTimeout(timer);
      releaseSlot();
    }
  }

  function loadSymbol(symbol, asOf) {
    const key = cacheKey(symbol, asOf);
    pruneCache(now());
    const hit = cache.get(key);
    if (hit) return Promise.resolve(publish({ cacheable: true, quote: hit.quote }));

    const pending = inflight.get(key);
    if (pending) return pending.then((outcome) => publish(outcome));

    const job = requestOne(symbol, asOf).then((outcome) => {
      if (!outcome.cacheable) return outcome;
      return { cacheable: true, quote: remember(key, outcome.quote) };
    });
    inflight.set(key, job);
    return job.finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    }).then((outcome) => publish(outcome));
  }

  async function mapPool(symbols, asOf) {
    const settled = new Map();
    let cursor = 0;
    const workers = Math.min(limit, symbols.length);

    async function run() {
      while (cursor < symbols.length) {
        const symbol = symbols[cursor];
        cursor += 1;
        settled.set(symbol, await loadSymbol(symbol, asOf));
      }
    }

    await Promise.all(Array.from({ length: workers }, () => run()));
    const ordered = new Map();
    for (const symbol of symbols) ordered.set(symbol, settled.get(symbol));
    return ordered;
  }

  return async function fallbackDailyQuotes(symbols, asOf) {
    const unique = dedupeSymbols(symbols);
    if (unique.length === 0) return new Map();
    return mapPool(unique, asOf);
  };
}
