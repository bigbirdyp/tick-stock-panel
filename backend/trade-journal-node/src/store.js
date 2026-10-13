import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './validation.js';
import { currentPositions, derive, publicHistory, sortHistory, sortPositions, sortRecords, sortReviews } from './positions.js';

const SCHEMA_VERSION = 3;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3]);
const UNSPECIFIED_TRADER = '未指定';
const TRADER_MAX = 64;
const emptyState = () => ({ schema_version: SCHEMA_VERSION, records: [], reviews: [], requests: [] });
const notFound = () => new ApiError(404, 'NOT_FOUND', '指定资源不存在');
const versionConflict = () => new ApiError(409, 'VERSION_CONFLICT', '资源版本已变化，请重新加载');
const duplicateRecord = () => new ApiError(409, 'DUPLICATE_RECORD', 'client_request_id 已用于其他交易记录');
const duplicateReview = () => new ApiError(409, 'DUPLICATE_REVIEW', '该日期下该交易者已有每日复盘');

function shanghaiTimestamp(milliseconds) {
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

export function todayShanghai() {
  return shanghaiTimestamp(Date.now()).slice(0, 10);
}

function page(items, { limit, offset }) {
  return {
    items: items.slice(offset, offset + limit),
    pagination: { limit, offset, total: items.length, has_more: offset + limit < items.length },
  };
}

function publicRecord(record) {
  return { ...record, price: Number(record.price), fee: Number(record.fee), tax: Number(record.tax) };
}

function recordFingerprint(record) {
  return JSON.stringify([
    record.trader, record.trade_date, record.trade_time, record.code, record.symbol, record.name,
    record.side, record.price, record.quantity, record.fee, record.tax,
    record.note, record.client_request_id,
  ]);
}

function canonicalTrader(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > TRADER_MAX) return null;
  return trimmed;
}

function assertStateShape(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid trade journal data file');
  if (!SUPPORTED_SCHEMA_VERSIONS.has(state.schema_version)) throw new Error('invalid trade journal data file');
  if (!Array.isArray(state.records) || !Array.isArray(state.reviews) || !Array.isArray(state.requests)) {
    throw new Error('invalid trade journal data file');
  }
}

function repairRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid trade journal data file');
  const trader = canonicalTrader(record.trader) ?? UNSPECIFIED_TRADER;
  if (record.trader === trader) return record;
  return { ...record, trader };
}

function repairReview(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw new Error('invalid trade journal data file');
  const trader = canonicalTrader(review.trader) ?? UNSPECIFIED_TRADER;
  if (review.trader === trader) return review;
  return { ...review, trader };
}

// A joined string can collide when a label itself contains the separator.
function assertUniqueReviewKeys(reviews) {
  const seen = new Set();
  for (const review of reviews) {
    const key = JSON.stringify([review.date, review.trader]);
    if (seen.has(key)) throw new Error('invalid trade journal data file: duplicate review date and trader');
    seen.add(key);
  }
}

function reviewKeyTaken(reviews, date, trader, exceptId) {
  return reviews.some((item) => item.id !== exceptId && item.date === date && item.trader === trader);
}

function parseFingerprint(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && (parsed.length === 12 || parsed.length === 13)) return parsed;
  } catch {
    return null;
  }
  return null;
}

// Copy the stored twelve creation elements and prepend the migrated trader.
// Rebuilding them from the record would pin later PATCH prices into the key.
function upgradeRequests(requests, traderById) {
  const liveIds = new Set(traderById.keys());
  const next = [];
  let changed = false;
  for (const request of requests) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid trade journal data file');
    if (!liveIds.has(request.recordId)) {
      changed = true;
      continue;
    }
    const parsed = parseFingerprint(request.fingerprint);
    if (!parsed || parsed.length === 13) {
      next.push(request);
      continue;
    }
    changed = true;
    next.push({ ...request, fingerprint: JSON.stringify([traderById.get(request.recordId), ...parsed]) });
  }
  return { requests: changed ? next : requests, changed };
}

function migrateState(state) {
  const records = state.records.map(repairRecord);
  const recordsChanged = records.some((record, index) => record !== state.records[index]);
  const traderById = new Map(records.map((record) => [record.id, record.trader]));
  const upgraded = upgradeRequests(state.requests, traderById);
  const reviews = state.reviews.map(repairReview);
  const reviewsChanged = reviews.some((review, index) => review !== state.reviews[index]);
  // Reject before returning a writable state so a duplicate key cannot be persisted or served.
  assertUniqueReviewKeys(reviews);
  if (state.schema_version === SCHEMA_VERSION && !recordsChanged && !upgraded.changed && !reviewsChanged) return state;
  return {
    ...state,
    schema_version: SCHEMA_VERSION,
    records: recordsChanged ? records : state.records,
    reviews: reviewsChanged ? reviews : state.reviews,
    requests: upgraded.requests,
  };
}

function sameTrader(value, trader) {
  return trader === undefined || value === trader;
}

function retargetRequestKey(draft, recordId, previousKey, nextKey, snapshot) {
  if (nextKey === null) {
    draft.requests = draft.requests.filter((request) => request.recordId !== recordId);
    return;
  }
  if (nextKey === previousKey) return;
  const existing = draft.requests.find((request) => request.key === nextKey);
  if (existing) {
    if (existing.recordId !== recordId) throw duplicateRecord();
    return;
  }
  draft.requests.push({ key: nextKey, recordId, fingerprint: recordFingerprint(snapshot) });
}

function persist(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, filePath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* temp may not have been created */ }
    throw error;
  }
}

export class JournalStore {
  constructor(filePath) {
    this.filePath = filePath;
    const loaded = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : emptyState();
    assertStateShape(loaded);
    const migrated = migrateState(loaded);
    derive(migrated.records);
    if (migrated !== loaded) persist(filePath, migrated);
    this.state = migrated;
    this.lastTimestampMs = 0;
    for (const item of [...this.state.records, ...this.state.reviews]) {
      this.lastTimestampMs = Math.max(this.lastTimestampMs, Date.parse(item.created_at), Date.parse(item.updated_at));
    }
  }

  timestamp() {
    this.lastTimestampMs = Math.max(Date.now(), this.lastTimestampMs + 1);
    return shanghaiTimestamp(this.lastTimestampMs);
  }

  commit(draft) {
    // A single Node process executes this synchronous section without interleaving writes.
    derive(draft.records);
    persist(this.filePath, draft);
    this.state = draft;
  }

  createRecord(input) {
    const requestKey = input.client_request_id;
    const fingerprint = recordFingerprint(input);
    const existingRequest = requestKey ? this.state.requests.find((item) => item.key === requestKey) : null;
    if (existingRequest) {
      if (existingRequest.fingerprint !== fingerprint) throw new ApiError(409, 'DUPLICATE_RECORD', 'client_request_id 已用于不同交易记录');
      const record = this.state.records.find((item) => item.id === existingRequest.recordId);
      if (record) return { record: publicRecord(record), duplicate: true };
    }
    const draft = structuredClone(this.state);
    const timestamp = this.timestamp();
    const record = { id: `rec_${randomUUID()}`, version: 1, ...input, created_at: timestamp, updated_at: timestamp };
    draft.records.push(record);
    if (requestKey) draft.requests.push({ key: requestKey, recordId: record.id, fingerprint });
    this.commit(draft);
    return { record: publicRecord(record), duplicate: false };
  }

  getRecord(id) {
    const record = this.state.records.find((item) => item.id === id);
    if (!record) throw notFound();
    return publicRecord(record);
  }

  listRecords(query) {
    const filtered = this.state.records.filter((record) =>
      (!query.date || record.trade_date === query.date) &&
      (!query.from || record.trade_date >= query.from) &&
      (!query.to || record.trade_date <= query.to) &&
      (!query.code || record.code === query.code) &&
      (!query.side || record.side === query.side) &&
      sameTrader(record.trader, query.trader));
    const result = page(sortRecords(filtered, query.sort), query);
    return { records: result.items.map(publicRecord), pagination: result.pagination };
  }

  patchRecord(id, changes) {
    const current = this.state.records.find((item) => item.id === id);
    if (!current) throw notFound();
    if (current.version !== changes.expected_version) throw versionConflict();
    const { expected_version, ...fields } = changes;
    if (Object.hasOwn(fields, 'client_request_id') && fields.client_request_id && fields.client_request_id !== current.client_request_id) {
      const existing = this.state.requests.find((item) => item.key === fields.client_request_id);
      if (existing && existing.recordId !== id) throw duplicateRecord();
    }
    const draft = structuredClone(this.state);
    const index = draft.records.findIndex((item) => item.id === id);
    const updated = { ...draft.records[index], ...fields, version: current.version + 1, updated_at: this.timestamp() };
    draft.records[index] = updated;
    if (Object.hasOwn(fields, 'client_request_id')) {
      retargetRequestKey(draft, id, current.client_request_id ?? null, fields.client_request_id, updated);
    }
    this.commit(draft);
    return publicRecord(updated);
  }

  deleteRecord(id, expectedVersion) {
    const current = this.state.records.find((item) => item.id === id);
    if (!current) throw notFound();
    if (current.version !== expectedVersion) throw versionConflict();
    const draft = structuredClone(this.state);
    draft.records = draft.records.filter((item) => item.id !== id);
    draft.requests = draft.requests.filter((request) => request.recordId !== id);
    this.commit(draft);
  }

  createReview(input) {
    if (reviewKeyTaken(this.state.reviews, input.date, input.trader)) throw duplicateReview();
    const draft = structuredClone(this.state);
    const timestamp = this.timestamp();
    const review = { id: `rev_${randomUUID()}`, version: 1, ...input, created_at: timestamp, updated_at: timestamp };
    draft.reviews.push(review);
    this.commit(draft);
    return review;
  }

  getReview(id) {
    const review = this.state.reviews.find((item) => item.id === id);
    if (!review) throw notFound();
    return review;
  }

  listReviews(query) {
    const filtered = this.state.reviews.filter((review) =>
      (!query.date || review.date === query.date) &&
      (!query.from || review.date >= query.from) &&
      (!query.to || review.date <= query.to) &&
      (!query.tag || review.tags.includes(query.tag)) &&
      sameTrader(review.trader, query.trader));
    const result = page(sortReviews(filtered, query.sort), query);
    return { reviews: result.items, pagination: result.pagination };
  }

  patchReview(id, changes) {
    const current = this.state.reviews.find((item) => item.id === id);
    if (!current) throw notFound();
    if (current.version !== changes.expected_version) throw versionConflict();
    const { expected_version, ...fields } = changes;
    const nextDate = Object.hasOwn(fields, 'date') ? fields.date : current.date;
    const nextTrader = Object.hasOwn(fields, 'trader') ? fields.trader : current.trader;
    if (reviewKeyTaken(this.state.reviews, nextDate, nextTrader, id)) throw duplicateReview();
    const draft = structuredClone(this.state);
    const index = draft.reviews.findIndex((item) => item.id === id);
    const updated = { ...draft.reviews[index], ...fields, version: current.version + 1, updated_at: this.timestamp() };
    draft.reviews[index] = updated;
    this.commit(draft);
    return updated;
  }

  deleteReview(id, expectedVersion) {
    const current = this.state.reviews.find((item) => item.id === id);
    if (!current) throw notFound();
    if (current.version !== expectedVersion) throw versionConflict();
    const draft = structuredClone(this.state);
    draft.reviews = draft.reviews.filter((item) => item.id !== id);
    this.commit(draft);
  }

  listTraders() {
    const recordCounts = new Map();
    const reviewCounts = new Map();
    for (const record of this.state.records) recordCounts.set(record.trader, (recordCounts.get(record.trader) ?? 0) + 1);
    for (const review of this.state.reviews) reviewCounts.set(review.trader, (reviewCounts.get(review.trader) ?? 0) + 1);
    const traders = [...new Set([...recordCounts.keys(), ...reviewCounts.keys()])].sort().map((trader) => ({
      trader,
      record_count: recordCounts.get(trader) ?? 0,
      review_count: reviewCounts.get(trader) ?? 0,
    }));
    return { traders };
  }

  current(query) {
    const asOf = query.as_of ?? todayShanghai();
    const records = this.state.records.filter((record) => record.trade_date <= asOf);
    const filtered = currentPositions(records).filter((position) =>
      (!query.code || position.code === query.code) && sameTrader(position.trader, query.trader));
    const result = page(sortPositions(filtered, query.sort), query);
    return { as_of: asOf, positions: result.items, pagination: result.pagination };
  }

  history(query) {
    const filtered = derive(this.state.records).history.filter((row) =>
      (!query.from || row.close_date >= query.from) &&
      (!query.to || row.close_date <= query.to) &&
      (!query.code || row.code === query.code) &&
      sameTrader(row.trader, query.trader));
    const result = page(sortHistory(filtered, query.sort), query);
    return { history: result.items.map(publicHistory), pagination: result.pagination };
  }
}
