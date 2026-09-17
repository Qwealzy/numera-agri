import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const debugDashboardRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same loopback floor as debug.js's own router -- this serves the same
// category of unauthenticated ledger/SQL data (party ids, contract ids,
// amounts), just pre-rendered instead of raw JSON. Delete alongside
// debug.js before any deployment that isn't literally your own machine's
// LocalNet.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
debugDashboardRouter.use((req, res, next) => {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'debug routes are loopback-only' });
  }
  next();
});

// Read-only: fetches its data client-side from the existing, untouched
// GET /debug/contracts. This route only ever serves the static page.
debugDashboardRouter.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'debug-dashboard.html'));
});
