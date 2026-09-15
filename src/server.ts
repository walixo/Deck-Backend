import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/db';
import { env } from './config/env';

/**
 * How long a shutdown may take before the process stops being polite.
 *
 * Platforms send SIGTERM and then SIGKILL a short while later — ten seconds on
 * most, thirty on some. Exiting under our own power inside that window means
 * the logs say why the process stopped; being killed means they say nothing,
 * and a keep-alive connection that never closes is enough to cause it.
 */
const SHUTDOWN_GRACE_MS = 8_000;

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const app = createApp();

  const server = app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] Deck API listening on http://localhost:${env.port}`);
  });

  let closing = false;

  const shutdown = (signal: string): void => {
    /* A platform that has already sent SIGTERM will often send it again while
       it waits. Running the teardown twice closes a connection that is already
       closing and throws on the way out. */
    if (closing) return;
    closing = true;

    // eslint-disable-next-line no-console
    console.log(`\n[server] ${signal} received, shutting down`);

    /* Unref'd, so this timer is not itself a reason for the process to stay
       alive — it only fires if something else is holding the loop open. */
    const forced = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('[server] shutdown timed out, exiting anyway');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forced.unref();

    server.close(() => {
      /*
       * Mongo last, and actually closed.
       *
       * Every script in this codebase disconnects when it finishes and the
       * server was the one thing that did not — it dropped the socket instead,
       * which Atlas logs as an error on its side and which gives an in-flight
       * write no chance to land. Closing the HTTP server first means no new
       * request can arrive to need the connection we are about to end.
       */
      void disconnectDatabase()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[server] failed to start:', error);
  process.exit(1);
});
