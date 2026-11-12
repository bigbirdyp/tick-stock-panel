import { fileURLToPath } from 'node:url';

export const dataFile = process.env.TRADE_JOURNAL_DATA_FILE || fileURLToPath(new URL('../.data/journal.json', import.meta.url));

// FastAPI forwards journal requests to this internal loopback port. Ambient PORT
// belongs to other processes (FastAPI, the jaw server) and must not move this listener.
export function journalPort(env = process.env) {
  const raw = env.TRADE_JOURNAL_PORT;
  if (raw == null || raw === '') return 3022;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('TRADE_JOURNAL_PORT must be a valid TCP port');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error('TRADE_JOURNAL_PORT must be a valid TCP port');
  return port;
}
