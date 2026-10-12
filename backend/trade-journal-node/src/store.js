import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './validation.js';
import { currentPositions, derive, publicHistory, sortHistory, sortPositions, sortRecords, sortReviews } from './positions.js';

const emptyState = () => ({ schema_version: 1, records: [], reviews: [], requests: [] });
const notFound = () => new ApiError(404, 'NOT_FOUND', '指定资源不存在');
const versionConflict = () => new ApiError(409, 'VERSION_CONFLICT', '资源版本已变化，请重新加载');

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
    record.trade_date, record.trade_time, record.code, record.symbol, record.name,
    record.side, record.price, record.quantity, record.fee, record.tax,
    record.note, record.client_request_id,
  ]);
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
    this.state = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : emptyState();
    if (this.state.schema_version !== 1 || !Array.isArray(this.state.records) || !Array.isArray(this.state.reviews) ||
        !Array.isArray(this.state.requests)) {
      throw new Error('invalid trade journal data file');
    }
    derive(this.state.records);
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
      (!query.side || record.side === query.side));
    const result = page(sortRecords(filtered, query.sort), query);
    return { records: result.items.map(publicRecord), pagination: result.pagination };
  }

  patchRecord(id, changes) {
    const current = this.state.records.find((item) => item.id === id);
    if (!current) throw notFound();
    if (current.version !== changes.expected_version) throw versionConflict();
    const { expected_version, ...fields } = changes;
    const key = fields.client_request_id;
    const matchingRequest = key ? this.state.requests.find((item) => item.key === key) : null;
    if (matchingRequest && matchingRequest.recordId !== id) {
      throw new ApiError(409, 'DUPLICATE_RECORD', 'client_request_id 已用于其他交易记录');
    }
    const draft = structuredClone(this.state);
    const index = draft.records.findIndex((item) => item.id === id);
    const updated = { ...draft.records[index], ...fields, version: current.version + 1, updated_at: this.timestamp() };
    draft.records[index] = updated;
    if (key && !matchingRequest) {
      draft.requests.push({ key, recordId: id, fingerprint: recordFingerprint(updated) });
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
    if (this.state.reviews.some((item) => item.date === input.date)) throw new ApiError(409, 'DUPLICATE_REVIEW', '该日期已有每日复盘');
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
      (!query.tag || review.tags.includes(query.tag)));
    const result = page(sortReviews(filtered, query.sort), query);
    return { reviews: result.items, pagination: result.pagination };
  }

  patchReview(id, changes) {
    const current = this.state.reviews.find((item) => item.id === id);
    if (!current) throw notFound();
    if (current.version !== changes.expected_version) throw versionConflict();
    const { expected_version, ...fields } = changes;
    if (fields.date && fields.date !== current.date && this.state.reviews.some((item) => item.date === fields.date)) {
      throw new ApiError(409, 'DUPLICATE_REVIEW', '该日期已有每日复盘');
    }
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

  current(query) {
    const asOf = query.as_of ?? todayShanghai();
    const records = this.state.records.filter((record) => record.trade_date <= asOf);
    const filtered = currentPositions(records).filter((position) => !query.code || position.code === query.code);
    const result = page(sortPositions(filtered, query.sort), query);
    return { as_of: asOf, positions: result.items, pagination: result.pagination };
  }

  history(query) {
    const filtered = derive(this.state.records).history.filter((row) =>
      (!query.from || row.close_date >= query.from) &&
      (!query.to || row.close_date <= query.to) &&
      (!query.code || row.code === query.code));
    const result = page(sortHistory(filtered, query.sort), query);
    return { history: result.items.map(publicHistory), pagination: result.pagination };
  }
}
