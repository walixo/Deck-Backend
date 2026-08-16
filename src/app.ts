import cors from 'cors';
import express, { type Application } from 'express';
import morgan from 'morgan';
import { env } from './config/env';
import { UPLOAD_DIR, UPLOAD_ROUTE } from './config/uploads';
import { paystackWebhook } from './controllers/payment.controller';
import { errorHandler, notFoundHandler } from './middleware/error';
import { hasFrontendBuild, mountFrontend } from './middleware/unfurl';
import routes from './routes';
import { asyncHandler } from './utils/asyncHandler';

export function createApp(): Application {
  const app = express();
  /* Decided up front: the root route needs to know, and it is registered
     before the mount happens. */
  const frontendMounted = hasFrontendBuild();

  /*
   * Behind a reverse proxy, `req.ip` is the proxy unless Express is told to
   * read X-Forwarded-For. The audit trail records that value, and an IP column
   * that says "the load balancer" for every entry is worse than no column at
   * all — it looks like real evidence and is not.
   *
   * Opt-in via TRUST_PROXY, because trusting the header unconditionally lets
   * any client spoof its own address when there is no proxy in front.
   */
  if (env.trustProxy) app.set('trust proxy', env.trustProxy);

  app.use(
    cors({
      origin(origin, callback) {
        // Allow tools without an Origin header (curl, server-to-server).
        if (!origin || env.clientOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
    }),
  );

  /*
   * Paystack signs the raw request body, so the webhook must see the exact
   * bytes sent. It is registered before express.json() — once that has parsed
   * and discarded the buffer, the signature can never be recomputed.
   */
  app.post(
    '/api/payments/paystack/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    asyncHandler(paystackWebhook),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!env.isProduction) {
    app.use(morgan('dev'));
  }

  /*
   * Only when this server is API-only. With a frontend mounted, `/` is the home
   * page — answering it with JSON would mean the site's own root served a blob
   * of API metadata to every visitor.
   */
  app.get('/', (_req, res, next) => {
    if (frontendMounted) return next();
    res.json({ success: true, data: { name: 'Deck API', version: '1.0.0', docs: '/api/health' } });
  });

  /*
   * Uploaded images. `nosniff` matters here: these are user-supplied files
   * served from our own origin, so the browser must never second-guess the
   * Content-Type we set. Filenames are content-addressed random UUIDs, so they
   * are safe to cache immutably.
   */
  app.use(
    UPLOAD_ROUTE,
    express.static(UPLOAD_DIR, {
      index: false,
      dotfiles: 'deny',
      maxAge: env.isProduction ? '1y' : 0,
      immutable: env.isProduction,
      setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
      },
    }),
  );

  app.use('/api', routes);

  /* Serves the built frontend when one is present, giving launch pages their
     own Open Graph tags. A no-op in development, where Vite serves the app. */
  mountFrontend(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
