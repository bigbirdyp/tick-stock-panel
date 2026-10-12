import { readFileSync } from 'node:fs';
import { dataFile } from './config.js';
import { JournalStore } from './store.js';
import { recordInput, reviewInput } from './validation.js';

const seed = JSON.parse(readFileSync(new URL('../seed/seed.json', import.meta.url), 'utf8'));
const store = new JournalStore(dataFile);
for (const row of seed.records) store.createRecord(recordInput(row));
for (const row of seed.reviews) {
  if (!store.state.reviews.some((review) => review.date === row.date)) store.createReview(reviewInput(row));
}
console.info(`[trade-journal-node] seed ready: ${store.state.records.length} records, ${store.state.reviews.length} reviews`);
