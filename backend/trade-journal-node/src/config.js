import { fileURLToPath } from 'node:url';

export const dataFile = process.env.TRADE_JOURNAL_DATA_FILE || fileURLToPath(new URL('../.data/journal.json', import.meta.url));
