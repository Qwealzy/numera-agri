// The Express app, with nothing in it that listens or starts a loop, so a
// test can mount it on an ephemeral port and measure what a client sees.
// server.js is what listens and what starts the eight background loops --
// the same split as errorHandler.js and health.js, and for the same reason:
// importing server.js starts a server.
//
// Routes, their order, their bodies and their status codes are exactly what
// they were when this lived in server.js, except that /debug is now mounted
// only when DEBUG_ROUTES_ENABLED is 'true' (see createApp). The only thing
// this module decides is composition.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { policiesRouter } from './routes/policies.js';
import { debugRouter } from './routes/debug.js';
import { debugDashboardRouter } from './routes/debugDashboard.js';
import { errorHandler } from './errorHandler.js';
import { healthHandler } from './health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The /health probes stay injected: server.js passes the real ones, a test
// passes fakes and reaches neither the database nor the ledger.
// debugRoutes is DEBUG_ROUTES_ENABLED's raw value (config.debugRoutes, passed
// by server.js): /debug is mounted only when it is exactly 'true'. Anything
// else, a missing value included, leaves it unmounted and /debug/* is 404.
export function createApp({ probeDatabase, probeLedger, processDegraded, debugRoutes }) {
  const app = express();
  app.use(express.json());

  app.get('/health', healthHandler({ probeDatabase, probeLedger, processDegraded }));
  app.use('/api/v1', policiesRouter);
  if (debugRoutes === 'true') {
    console.warn('[server] DEBUG_ROUTES_ENABLED=true: /debug routes are ON (loopback only, no authentication); they must be off in any deployment');
    app.use('/debug', debugRouter);
    app.use('/debug', debugDashboardRouter);
  } else if (debugRoutes !== undefined && debugRoutes !== '') {
    console.warn(`[server] DEBUG_ROUTES_ENABLED=${JSON.stringify(debugRoutes)} is not recognised (only "true" turns them on): /debug routes are OFF`);
  }
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(errorHandler);
  return app;
}
