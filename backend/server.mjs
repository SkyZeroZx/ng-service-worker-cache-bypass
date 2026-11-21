import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/ng-service-worker-cache-bypass/browser');
const port = 4200;

const sessions = new Map(); // session id -> user
let requests = 0; // /api/me requests received

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function sessionId(req) {
  return /(?:^|;\s*)session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (req.method === 'POST' && url.pathname === '/auth/login') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const id = randomBytes(16).toString('hex');
    sessions.set(id, JSON.parse(body).user);
    return json(
      res,
      200,
      { ok: true },
      {
        'Cache-Control': 'no-store',
        'Set-Cookie': `session=${id}; Path=/; HttpOnly; SameSite=Strict`,
      },
    );
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    sessions.delete(sessionId(req));
    return json(
      res,
      200,
      { ok: true },
      {
        'Cache-Control': 'no-store',
        'Set-Cookie': 'session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
      },
    );
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = sessions.get(sessionId(req)) ?? null;
    const request = ++requests;
    console.log(`#${request} GET ${url.pathname}${url.search}  session: ${user ?? 'none'}`);

    // Like a real API, the answer takes a moment.
    await new Promise((done) => setTimeout(done, 300));

    const body = user ? { user, email: `${user}@example.test`, request } : { user: null, request };
    return json(res, 200, body, { 'Cache-Control': 'no-store, private', Vary: 'Cookie' });
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

  try {
    const path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = resolve(dist, `.${path}`);
    if (!file.startsWith(dist + sep)) return json(res, 403, { error: 'forbidden' });

    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
