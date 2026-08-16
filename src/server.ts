import { createApp } from './app';
import { connectDatabase } from './config/db';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const app = createApp();

  const server = app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] Deck API listening on http://localhost:${env.port}`);
  });

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`\n[server] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[server] failed to start:', error);
  process.exit(1);
});
