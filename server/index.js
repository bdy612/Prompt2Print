// Prompt2Print server entry point.
//   node server/index.js            (development: http://127.0.0.1:3939)
//   Prompt2Print.exe                (Windows app: started by the launcher)

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Prompt2Print needs Node.js 22.13 or newer (you have ${process.versions.node}). Install the LTS version from https://nodejs.org`);
  process.exit(1);
}

const { default: http } = await import('node:http');
const { default: fs } = await import('node:fs');
const { default: path } = await import('node:path');
const { config } = await import('./config.js');
const { Router, HttpError, sendJson, serveStatic, securityHeaders } = await import('./lib/http.js');
const { attachIdentity } = await import('./auth.js');
const { registerStoreRoutes } = await import('./routes/store.js');
const { registerAdminRoutes } = await import('./routes/admin.js');
const { ensureSeeded, seedState } = await import('./seed.js');
const { startPrintWorker } = await import('./printing/queue.js');
const { resumePendingDesigns } = await import('./designs.js');

// In the Windows app there is no console: keep a log file.
if (config.desktop) {
  const logFile = fs.createWriteStream(path.join(config.logsDir, 'app.log'), { flags: 'a' });
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      logFile.write(`${new Date().toISOString()} [${level}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
      try { orig(...args); } catch { /* no console attached */ }
    };
  }
}

const router = new Router();
registerStoreRoutes(router);
registerAdminRoutes(router);

const indexHtml = () => fs.readFileSync(path.join(config.publicDir, 'index.html'));

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  let rawPath = '/';
  try {
    const url = new URL(req.url, 'http://local');
    rawPath = url.pathname; // still percent-encoded; the router decodes route parameters itself
    if (rawPath === '/api/health') {
      // The download website may ask the local app whether it is running (CORS + private network).
      const origin = req.headers.origin || '';
      if (/^https:\/\/bdy612\.github\.io$/.test(origin) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }
    if (rawPath.startsWith('/api/')) {
      // Simple CSRF protection: state-changing API calls must come from our own scripts.
      if (req.method !== 'GET' && req.method !== 'HEAD' && !/^\/api\/payments\/(stripe|tap)\/webhook$/.test(rawPath) && req.headers['x-p2p'] !== '1') {
        throw new HttpError(403, 'Missing request header.', 'csrf');
      }
      if (seedState.running && rawPath !== '/api/health') {
        sendJson(res, 503, { setup: { done: seedState.done, total: seedState.total }, error: { message: 'Setting up the shop…', code: 'setting_up' } });
        return;
      }
      attachIdentity(req, res);
      const m = router.match(req.method, rawPath);
      if (!m) throw new HttpError(404, 'Unknown API route.', 'not_found');
      req.params = m.params;
      req.query = Object.fromEntries(url.searchParams);
      let result;
      for (const h of m.route.handlers) result = await h(req, res);
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      return;
    }
    const pathname = decodeURIComponent(rawPath);
    if (pathname.startsWith('/media/')) {
      if (serveStatic(req, res, config.mediaDir, pathname.slice(7), { maxAge: 86400 })) return;
      throw new HttpError(404, 'Not found');
    }
    // Static front-end files; any other path is a page of the single-page app.
    if (pathname !== '/' && serveStatic(req, res, config.publicDir, pathname, { maxAge: pathname.startsWith('/vendor/') ? 604800 : 0 })) return;
    if (path.extname(pathname) && !pathname.endsWith('.html')) throw new HttpError(404, 'Not found');
    attachIdentity(req, res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(indexHtml());
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof URIError ? 400 : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) { res.end(); return; }
    if (rawPath.startsWith('/api/')) {
      const message = status === 500 ? 'Something went wrong on our side. Try again.' : status === 400 && !(err instanceof HttpError) ? 'Bad request.' : err.message;
      sendJson(res, status, { error: { message, code: err.code || 'error', ...(err.extra || {}) } });
    } else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 404 ? 'Not found' : status === 400 ? 'Bad request' : 'Server error');
    }
  }
});

// Never let one bad request or background task take the whole shop down.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

server.listen(config.port, config.host, () => {
  const addr = server.address();
  console.log(`Prompt2Print is running at http://${addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address}:${addr.port}`);
  console.log(`Data folder: ${config.dataDir}`);
  ensureSeeded()
    .then(() => { startPrintWorker(); resumePendingDesigns(); })
    .catch((err) => { console.error('Setup failed:', err); process.exit(1); });
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Close the other copy of Prompt2Print or set P2P_PORT.` : err);
  process.exit(1);
});

const shutdown = () => { server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
