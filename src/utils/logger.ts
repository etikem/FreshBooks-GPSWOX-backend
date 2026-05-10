import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'freshbooks-abctrack' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-freshbooks-hmac"]',
      '*.apiKey',
      '*.token',
      '*.password',
      'env.FRESHBOOKS_API_TOKEN',
      'env.FRESHBOOKS_API_REFRESH_TOKEN',
      'env.FRESHBOOKS_CLIENT_SECRET',
      '*.access_token',
      '*.refresh_token',
      '*.accessToken',
      '*.refreshToken',
      'env.ABCTRACK_PASSWORD',
      'env.JWT_SECRET',
      'env.ADMIN_PASSWORD_HASH',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;
