import { Router, raw } from 'express';
import { freshbooksWebhookHandler } from '../controllers/webhook.controller';

export const webhookRouter = Router();

// Raw body required for HMAC verification.
webhookRouter.post(
  '/freshbooks',
  raw({ type: '*/*', limit: '2mb' }),
  freshbooksWebhookHandler,
);
