// The Express app, with nothing in it that listens or starts a loop, so a
// test can mount it on an ephemeral port and measure what a client sees.
// server.js is what listens and what starts the seven background loops --
// the same split as errorHandler.js and health.js, and for the same reason:
// importing server.js starts a server.
//
// Routes, their order, their bodies and their status codes are exactly what
// they were when this lived in server.js. The only thing this module decides
// is composition.
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
export function createApp({ probeDatabase, probeLedger, processDegraded }) {
  const app = express();
  app.use(express.json());

  app.get('/health', healthHandler({ probeDatabase, probeLedger, processDegraded }));
  app.use('/api/v1', policiesRouter);
  app.use('/debug', debugRouter);
  app.use('/debug', debugDashboardRouter);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(errorHandler);
  return app;
}
