// Inject minimum required env vars BEFORE any src/* module loads. The
// runtime env validator (src/config/env.ts) calls process.exit(1) on
// missing keys, which kills the vitest process — this file is the only
// way to give the validator something to chew on without forcing every
// developer to populate a real .env.
//
// Values here are deliberately fake; tests that hit the network must
// mock the HTTP layer (see tests/abctrack.findUserByEmail.test.ts).

const required: Record<string, string> = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',

  FRESHBOOKS_API_TOKEN: 'test-token',
  FRESHBOOKS_API_REFRESH_TOKEN: 'test-refresh-token',
  FRESHBOOKS_CLIENT_ID: 'test-client-id',
  FRESHBOOKS_CLIENT_SECRET: 'test-client-secret',
  FRESHBOOKS_ACCOUNT_ID: 'test-account',
  FRESHBOOKS_BUSINESS_ID: 'test-business',
  FRESHBOOKS_WEBHOOK_SECRET: 'test-webhook-secret-min-8-chars',

  ABCTRACK_API_BASE: 'http://abctrack.test',
  ABCTRACK_EMAIL: 'tests@example.com',
  ABCTRACK_PASSWORD: 'test-password',

  JWT_SECRET: 'test-jwt-secret-at-least-sixteen-chars',
  ADMIN_USERNAME: 'administrator',
  // Pre-baked bcrypt hash of "test-password" (cost 4) — value doesn't
  // matter for tests, just has to satisfy the bcrypt-shape regex.
  ADMIN_PASSWORD_HASH: '$2a$04$abcdefghijklmnopqrstuv',
};

for (const [k, v] of Object.entries(required)) {
  if (!process.env[k]) process.env[k] = v;
}
