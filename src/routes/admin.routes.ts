import { Router } from 'express';
import { requireAdmin } from '../middleware/auth';
import {
  login,
  getStats,
  listClients,
  getClientDetail,
  triggerManualSync,
  listActionLogs,
  listWebhookEvents,
  listRetries,
  replayRetry,
  cancelRetry,
} from '../controllers/admin.controller';

export const adminRouter = Router();

// Public.
adminRouter.post('/login', login);

// Authed.
adminRouter.use(requireAdmin);

adminRouter.get('/stats', getStats);

adminRouter.get('/clients', listClients);
adminRouter.get('/clients/:id', getClientDetail);
adminRouter.post('/clients/:id/sync', triggerManualSync);

adminRouter.get('/logs/actions', listActionLogs);
adminRouter.get('/logs/webhooks', listWebhookEvents);

adminRouter.get('/retries', listRetries);
adminRouter.post('/retries/:id/replay', replayRetry);
adminRouter.post('/retries/:id/cancel', cancelRetry);
