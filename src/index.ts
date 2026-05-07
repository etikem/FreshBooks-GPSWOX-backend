import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { logger } from './utils/logger';
import { webhookRouter } from './routes/webhook.routes';
import { adminRouter } from './routes/admin.routes';
import { errorHandler } from './middleware/error-handler';
import { checkFreshbooksTokenAtStartup } from './utils/freshbooks-token';

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
      'GET,POST,PUT,DELETE,OPTIONS',
    );
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/admin', adminRouter);

app.use(errorHandler);

checkFreshbooksTokenAtStartup(env.FRESHBOOKS_API_TOKEN);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server.started');
});
