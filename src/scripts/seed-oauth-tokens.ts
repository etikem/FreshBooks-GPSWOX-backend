/**
 * One-shot recovery: write a known-good access+refresh pair into the
 * oauth_tokens row for `provider = 'freshbooks'`.
 *
 * Run after a manual refresh or full authorization-code flow has minted a
 * fresh pair (e.g. after a `invalid_grant` outage). The running backend
 * will pick this up within CACHE_TTL_MS (~30s) on its next outbound call —
 * no restart required.
 *
 * Usage from backend/:
 *   npm run oauth:seed -- \
 *     --access <ACCESS_TOKEN> \
 *     --refresh <REFRESH_TOKEN> \
 *     --expires-in 43200
 *
 * --expires-in is the OAuth `expires_in` value in seconds (FreshBooks
 * currently returns 43200 = 12h). Omit to leave expires_at NULL; the next
 * 401 + refresh will populate it correctly.
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

async function main(): Promise<void> {
  const accessToken = arg('access');
  const refreshToken = arg('refresh');
  const expiresInRaw = arg('expires-in');

  if (!accessToken || !refreshToken) {
    console.error(
      'Usage: --access <token> --refresh <token> [--expires-in <seconds>]',
    );
    process.exit(1);
  }

  const expiresIn = expiresInRaw ? Number(expiresInRaw) : null;
  if (expiresInRaw && !Number.isFinite(expiresIn)) {
    console.error(`--expires-in must be a number, got: ${expiresInRaw}`);
    process.exit(1);
  }
  const expiresAt =
    expiresIn !== null ? new Date(Date.now() + expiresIn * 1000) : null;

  const updated = await prisma.oauthToken.upsert({
    where: { provider: 'freshbooks' },
    update: { accessToken, refreshToken, expiresAt },
    create: {
      provider: 'freshbooks',
      accessToken,
      refreshToken,
      expiresAt,
    },
  });

  logger.info(
    {
      provider: updated.provider,
      expiresAt: updated.expiresAt,
      updatedAt: updated.updatedAt,
    },
    'freshbooks.token.seeded',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
