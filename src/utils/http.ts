import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from './logger';

export interface HttpClientOptions {
  baseURL: string;
  timeoutMs: number;
  defaultHeaders?: Record<string, string>;
  name: string; // for logs
}

export class TransientHttpError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'TransientHttpError';
  }
}

export class PermanentHttpError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = 'PermanentHttpError';
  }
}

export function createHttpClient(opts: HttpClientOptions): AxiosInstance {
  const client = axios.create({
    baseURL: opts.baseURL,
    timeout: opts.timeoutMs,
    headers: { 'content-type': 'application/json', ...opts.defaultHeaders },
  });

  client.interceptors.request.use((cfg) => {
    logger.debug({ name: opts.name, method: cfg.method, url: cfg.url }, 'http.request');
    return cfg;
  });

  client.interceptors.response.use(
    (res) => {
      logger.debug(
        { name: opts.name, status: res.status, url: res.config.url },
        'http.response',
      );
      return res;
    },
    (err: AxiosError) => {
      const status = err.response?.status;
      const body = err.response?.data;
      logger.warn(
        { name: opts.name, status, url: err.config?.url, err: err.message },
        'http.error',
      );
      // Network errors / 5xx / 408 / 429 → transient (retry-eligible).
      if (!status || status >= 500 || status === 408 || status === 429) {
        return Promise.reject(
          new TransientHttpError(`${opts.name} ${status ?? 'network'} error: ${err.message}`, status),
        );
      }
      // 4xx (other than 408/429) → permanent. Do not retry blindly.
      return Promise.reject(
        new PermanentHttpError(
          `${opts.name} ${status} error: ${err.message}`,
          status,
          body,
        ),
      );
    },
  );

  return client;
}

export type { AxiosRequestConfig };
