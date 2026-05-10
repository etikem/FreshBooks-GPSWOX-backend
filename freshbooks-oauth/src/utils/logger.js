// Tiny structured logger. Swap for pino/winston in production.
// Keeping it dependency-free so the example is easy to read.

function ts() {
  return new Date().toISOString();
}

function emit(level, msg, meta) {
  const line = { time: ts(), level, msg, ...(meta || {}) };
  // stdout for info/debug, stderr for warn/error — matches typical log shippers.
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => {
    if (process.env.DEBUG) emit('debug', msg, meta);
  },
};
