/**
 * Auth-only transport adapter. EVERY domain request is forwarded to Flask.
 * Flask binds a private Unix socket, not an externally reachable TCP port.
 */
import express from 'express';
import pinoHttp from 'pino-http';
import { clerkMiddleware, clerkClient, getAuth } from '@clerk/express';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from './middlewares/clerkProxyMiddleware';
import { logger } from './lib/logger';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const socketDirectory = await mkdtemp(path.join(tmpdir(), 'sideout-auth-'));
const socketPath = path.join(socketDirectory, 'flask.sock');
// Ephemeral, per-process transport key, never returned to a browser or logged.
const gatewaySecret = randomBytes(32).toString('hex');
const flask = spawn('uv', [
  'run', 'gunicorn', '--bind', `unix:${socketPath}`, '--workers', '1',
  '--threads', '4', '--timeout', '60', '--access-logfile', '-',
  '--access-logformat', '%(m)s %(U)s %(s)s', 'main:app',
], {
  cwd: root,
  env: { ...process.env, AUTH_GATEWAY_SECRET: gatewaySecret },
  stdio: ['ignore', 'inherit', 'inherit'],
});
let stopping = false;
flask.on('exit', (code) => {
  if (!stopping) {
    logger.error({ code }, 'Flask domain service exited');
    process.exit(code || 1);
  }
});
for (let attempt = 0; ; attempt++) {
  try { await stat(socketPath); break; }
  catch {
    if (attempt > 150) { flask.kill('SIGTERM'); throw new Error('Flask startup timed out'); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const app = express();
app.set('trust proxy', true);
app.use(pinoHttp({
  logger,
  serializers: {
    req(req) { return { id: req.id, method: req.method, url: req.url?.split('?')[0] }; },
    res(res) { return { statusCode: res.statusCode }; },
  },
}));
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);
app.use(express.raw({ type: () => true, limit: '1mb' }));
app.use(async (req, res) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // Cookie-authenticated writes must originate from this same application.
    const origin = req.headers.origin;
    const host = getClerkProxyHost(req);
    try {
      if (req.headers['sec-fetch-site'] === 'cross-site' ||
          (origin && new URL(origin).host !== host)) {
        res.status(403).json({ error: 'Cross-origin changes are not allowed.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid request origin.' });
      return;
    }
  }
  let userId: string | null = null;
  let email: string | null = null;
  try {
    userId = getAuth(req).userId;
    if (userId) {
      const user = await clerkClient.users.getUser(userId);
      const primary = user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId);
      // Only a server-retrieved, verified primary email may receive grants.
      if (primary?.verification?.status === 'verified') {
        email = primary.emailAddress.trim().toLowerCase();
      }
    }
  } catch {
    req.log.warn('Clerk account verification failed');
    res.status(503).json({ error: 'Account verification is temporarily unavailable.' });
    return;
  }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const timestamp = String(Date.now() / 1000);
  const identity = Buffer.from(JSON.stringify({ userId, email })).toString('base64');
  const digest = createHash('sha256').update(body).digest('hex');
  const message = [req.method, req.originalUrl, timestamp, identity, digest].join('\n');
  const signature = createHmac('sha256', gatewaySecret).update(message).digest('hex');
  const headers = { ...req.headers };
  delete headers['transfer-encoding'];
  delete headers.connection;
  // Replace, never append to, caller-provided gateway identity/signatures.
  headers['x-sideout-time'] = timestamp;
  headers['x-sideout-identity'] = identity;
  headers['x-sideout-signature'] = signature;
  headers['content-length'] = String(body.length);
  const upstream = httpRequest({
    socketPath, path: req.originalUrl, method: req.method, headers,
  }, (response) => {
    const responseHeaders = { ...response.headers };
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders.connection;
    res.writeHead(response.statusCode ?? 502, responseHeaders);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(60000, () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'Domain service unavailable.' });
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  upstream.end(body);
});
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1) throw new Error('PORT is required');
const server = app.listen(port, '0.0.0.0', () => logger.info({ port }, 'Clerk gateway and Flask domain service ready'));
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  flask.kill('SIGTERM');
  await rm(socketDirectory, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
