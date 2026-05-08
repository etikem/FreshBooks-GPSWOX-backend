import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Comma-separated allowlist of frontend origins permitted to call /admin.
  // Use "*" for an open CORS policy (only appropriate in dev).
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  FRESHBOOKS_API_TOKEN: z.string().min(1),
  FRESHBOOKS_ACCOUNT_ID: z.string().min(1),
  FRESHBOOKS_BUSINESS_ID: z.string().min(1),
  FRESHBOOKS_API_BASE: z.string().url().default('https://api.freshbooks.com'),
  FRESHBOOKS_WEBHOOK_SECRET: z.string().min(8),

  GPSWOX_API_BASE: z.string().url(),
  GPSWOX_USER_API_HASH: z.string().min(1),
  GPSWOX_LOGIN_PATH: z.string().min(1).default('/api/login'),
  GPSWOX_ENDPOINT_CLIENT_UPDATE: z.string().min(1).default('/api/admin/client'),
  GPSWOX_ENDPOINT_CLIENT_STATUS: z.string().min(1).default('/api/admin/client/status'),
  GPSWOX_LANG: z.string().min(1).default('en'),
  GPSWOX_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  JWT_SECRET: z.string().min(16),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_HASH: z.string().min(20),

  RETRY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail loud on boot — never start with bad config.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
