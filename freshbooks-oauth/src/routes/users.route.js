/**
 * users.route.js
 * --------------
 * Example Express router that proxies the FreshBooks "users/me" endpoint.
 *
 * Demonstrates that route handlers don't need any token-handling logic at
 * all — just call the service. The auto-refresh + retry happens transparently
 * inside freshbooks.service.js.
 */

const express = require('express');
const logger = require('../utils/logger');
const { getMe, freshbooksRequest } = require('../services/freshbooks.service');

const router = express.Router();

// GET /api/users/me — returns the FreshBooks identity for the authorized app.
router.get('/me', async (req, res) => {
  try {
    const data = await getMe();
    res.json(data);
  } catch (err) {
    // The service has already logged + tried refresh+retry. By the time we
    // get here, the failure is genuine.
    const status = err.response?.status || 500;
    logger.error('route.users.me.failed', {
      status,
      message: err.message,
      code: err.code,
    });
    res.status(status).json({
      error: 'freshbooks_request_failed',
      message: err.message,
      details: err.response?.data,
    });
  }
});

// Bonus: a generic passthrough so you can poke other endpoints from the same
// router during development. Remove or guard with auth in production.
router.get('/raw', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'missing url query param' });
  }
  try {
    const data = await freshbooksRequest({ method: 'GET', url });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: 'freshbooks_request_failed',
      message: err.message,
      details: err.response?.data,
    });
  }
});

module.exports = router;
