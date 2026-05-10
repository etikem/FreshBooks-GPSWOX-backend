import { Router } from 'express';
import { requireAdmin } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { env } from '../config/env';
import {
  login,
  getStats,
  listClients,
  getClientDetail,
  patchClient,
  triggerManualSync,
  listActionLogs,
  listWebhookEvents,
  replayWebhook,
  listRetries,
  replayRetry,
  cancelRetry,
  getNotifications,
} from '../controllers/admin.controller';

export const adminRouter = Router();

// Public — rate-limited per IP to slow brute-force.
adminRouter.post(
  '/login',
  rateLimit({ perMinute: env.LOGIN_RATE_LIMIT_PER_MIN }),
  login,
);

// Authed.
adminRouter.use(requireAdmin);

adminRouter.get('/stats', getStats);
adminRouter.get('/notifications', getNotifications);

adminRouter.get('/clients', listClients);
adminRouter.get('/clients/:id', getClientDetail);
adminRouter.patch('/clients/:id', patchClient);
adminRouter.post('/clients/:id/sync', triggerManualSync);

adminRouter.get('/logs/actions', listActionLogs);
adminRouter.get('/logs/webhooks', listWebhookEvents);
adminRouter.post('/logs/webhooks/:id/replay', replayWebhook);

adminRouter.get('/retries', listRetries);
adminRouter.post('/retries/:id/replay', replayRetry);
adminRouter.post('/retries/:id/cancel', cancelRetry);
