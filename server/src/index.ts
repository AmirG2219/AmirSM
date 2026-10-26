import { loadConfig } from './config.js';
import { createContext } from './bootstrap.js';
import { buildApp } from './app.js';

const config = loadConfig();
if (/onedrive|dropbox|google drive/i.test(config.dataDir)) {
  console.warn(`[amir-sm] WARNING: DATA_DIR (${config.dataDir}) looks like a cloud-synced folder. Syncing a live SQLite database and large videos can corrupt data or stall. Set DATA_DIR to a local folder in .env.`);
}
const ctx = createContext(config);
const app = await buildApp(ctx, { logger: true });
ctx.jobs.start();

const shutdown = async (sig: string) => {
  app.log.info(`${sig} received, shutting down`);
  await ctx.jobs.stop();
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
app.log.info(`Amir SM is running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
