/**
 * index.js
 * --------
 * Express entrypoint.
 *
 * Boot order matters:
 *   1. Load .env (must be first — token.service reads process.env at module load).
 *   2. Load tokens into the in-memory cache.
 *   3. Mount routes and start the server.
 */

require('dotenv').config();

const express = require('express');
const logger = require('./utils/logger');
const { loadTokens } = require('./services/token.service');
const usersRoute = require('./routes/users.route');

const app = express();
app.use(express.json());

// Health check — useful for load balancers and uptime probes.
app.get('/health', (req, res) => res.json({ ok: true }));

// Mount FreshBooks-backed routes under /api.
app.use('/api/users', usersRoute);

// Centralized error handler — catches anything routes forgot to handle.
app.use((err, req, res, next) => {
  logger.error('unhandled_error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal_error' });
});

const port = Number(process.env.PORT || 3000);

// Eagerly load tokens so the process fails fast if credentials are missing,
// instead of failing on the first request.
try {
  loadTokens();
} catch (err) {
  logger.error('boot.token_load_failed', { message: err.message });
  process.exit(1);
}

app.listen(port, () => {
  logger.info('server.listening', { port });
});
