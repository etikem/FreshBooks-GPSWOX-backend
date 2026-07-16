import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { logger } from './utils/logger';
import { webhookRouter } from './routes/webhook.routes';
import { adminRouter } from './routes/admin.routes';
import { errorHandler } from './middleware/error-handler';
import { checkFreshbooksTokenAtStartup } from './utils/freshbooks-token';
import { catchUpUnprocessedEvents } from './services/webhook.service';
import { runCronSweepOnce } from './services/cron-sweep.service';
import {
  loadTokens as loadFreshbooksTokens,
  getAccessToken as getFreshbooksAccessToken,
} from './services/freshbooks-token.service';
import { prisma } from './db/prisma';

const app = express();

app.use(helmet());

// Webhooks need raw body — mounted BEFORE express.json().
app.use('/webhooks', webhookRouter);

// Everything else gets JSON parsing.
app.use(express.json({ limit: '1mb' }));

// CORS for the admin dashboard. Allowlist driven by CORS_ORIGINS env.
const corsAllowlist = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowAnyOrigin = corsAllowlist.includes('*');

app.use((req, res, next) => {
  const origin = req.header('origin');
  if (origin && (allowAnyOrigin || corsAllowlist.includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header(
      'Access-Control-Allow-Headers',
      'authorization, content-type',
    );
    res.header(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Liveness probe — process is up.
app.get('/health', (_req, res) => res.json({ ok: true }));

// Readiness probe — process is up AND can talk to the DB.
app.get('/health/db', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'health.db.failed');
    res.status(503).json({ ok: false, error: 'db unreachable' });
  }
});

app.use('/admin', adminRouter);

app.use(errorHandler);

async function bootstrap(): Promise<void> {
  // Hydrate the oauth_tokens row (creating it from .env on first run) so the
  // first FreshBooks API call doesn't have to do it lazily. Failing to load
  // tokens at boot is fatal — every downstream call would 401.
  try {
    await loadFreshbooksTokens();
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      'boot.freshbooks_tokens.load_failed',
    );
    process.exit(1);
  }

  // Best-effort: surface "the access token we just loaded is already
  // expired" at boot rather than on the first 401. The OAuth refresh
  // pipeline will recover automatically on the first real request, but
  // the warning helps operators understand what they're seeing in logs.
  try {
    checkFreshbooksTokenAtStartup(await getFreshbooksAccessToken());
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'boot.freshbooks_tokens.expiry_check_failed',
    );
  }

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server.started');

    // Catch-up sweep — process any webhook events the previous run died
    // mid-flight on. Run after listen so a slow sweep doesn't delay
    // serving traffic. Failures here are logged but do not affect the API.
    if (env.CATCHUP_SWEEP_ON_BOOT) {
      catchUpUnprocessedEvents().catch((err) =>
        logger.warn({ err: (err as Error).message }, 'webhook.catchup.fatal'),
      );
    }

    // Access-expiry cron sweep, run from the API process. In a web-only
    // deployment (no separate worker) this is the ONLY thing that blocks
    // clients whose access window elapsed. Runs once shortly after boot,
    // then on CRON_SWEEP_INTERVAL_MS. Idempotent and local-only, so it's
    // safe even if a worker is also sweeping. Guarded so it can be disabled
    // when a dedicated worker owns the sweep.
    if (env.CRON_SWEEP_IN_API) {
      const runSweep = () =>
        runCronSweepOnce()
          .then((r) => {
            if (r.blocked > 0 || r.errors > 0) {
              logger.info(r, 'cron.sweep.api.done');
            }
          })
          .catch((err) =>
            logger.warn({ err: (err as Error).message }, 'cron.sweep.api.failed'),
          );
      // Kick once after a short delay so boot isn't blocked, then interval.
      setTimeout(runSweep, 30_000).unref?.();
      setInterval(runSweep, env.CRON_SWEEP_INTERVAL_MS).unref?.();
      logger.info(
        { intervalMs: env.CRON_SWEEP_INTERVAL_MS },
        'cron.sweep.api.scheduled',
      );
    }
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'boot.fatal');
  process.exit(1);
});
