import { dataFile } from './config.js';
import { createApp } from './server.js';
import { JournalStore } from './store.js';

const port = Number(process.env.PORT || 3022);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

const server = createApp(new JournalStore(dataFile));
server.listen(port, '127.0.0.1', () => {
  console.info(`[trade-journal-node] listening on http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
