import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { applyPr69302 } from './pr-69302.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4200';
const withFix = process.argv.includes('--with-fix');
const { version } = JSON.parse(
  readFileSync(resolve(root, 'node_modules/@angular/service-worker/package.json'), 'utf8'),
);
const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));

if (!chrome) throw new Error('Set CHROME_PATH to your Chrome or Edge executable.');

if (withFix) {
  await applyPr69302(resolve(root, 'dist/ng-service-worker-cache-bypass/browser/ngsw-worker.js'));
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });

try {
  console.log(`${await browser.version()}, @angular/service-worker ${version}`);

  const active = await run(`Service worker active${withFix ? ', with #69302' : ''}`, false);
  const control = await run('Service worker bypassed (control)', true);

  const expected = [
    ['alice', null, 'bob'],
    ['alice', null],
  ];
  assert.deepEqual(control.users, expected);
  assert.equal(control.requests, 5);

  if (withFix) {
    assert.deepEqual(active.users, expected);
    assert.equal(active.requests, 5);
    assert.deepEqual(active.cached, []);
    console.log('\nWith #69302 the service worker gives the same answers as the control.');
  } else {
    assert.deepEqual(active.users, [
      ['alice', 'alice', 'alice'],
      ['alice', 'alice'],
    ]);
    assert.equal(active.requests, 2);
    console.log(`
CONFIRMED on @angular/service-worker ${version}:
- case 1: after logout, a request with credentials: 'omit' and cache: 'no-store', and then bob,
  got alice's "no-store, private" response from CacheStorage.
- case 2: a request with credentials: 'omit' got the response of a request sent with alice's cookie.`);
  }
} finally {
  await browser.close();
}

// Runs both cases in a new browser profile, against a new server.
async function run(title, bypassServiceWorker) {
  const server = await startServer();
  const context = await browser.createBrowserContext();

  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error('Browser:', error.message));
    await page.setBypassServiceWorker(bypassServiceWorker);
    await page.goto(origin, { waitUntil: 'networkidle0' });

    if (!bypassServiceWorker) {
      await page.waitForFunction(
        () => document.querySelector('[data-testid="worker"]')?.textContent.trim() === 'active',
        { timeout: 60_000 },
      );
    }

    console.log(`\n${title}`);
    const users = [];
    for (const n of [1, 2]) {
      await page.click(`[data-testid="case-${n}"]`);
      await page.waitForFunction(
        (done) => {
          const status = document.querySelector('[data-testid="status"]')?.textContent.trim();
          return status === done || status?.startsWith('Error');
        },
        { timeout: 60_000 },
        `Case ${n} done`,
      );
      const status = await page.$eval('[data-testid="status"]', (el) => el.textContent.trim());
      assert.equal(status, `Case ${n} done`);

      const lines = await page.$$eval('li', (items) =>
        items.map((li) => ({
          text: li.querySelector('span').textContent.trim(),
          json: li.querySelector('code')?.textContent ?? null,
          repeat: li.classList.contains('repeat'),
        })),
      );
      console.log(`\n  case ${n}`);
      for (const { text, json, repeat } of lines) {
        console.log(
          `    ${text}${json ? ` -> ${json}` : ''}${repeat ? '  <-- never reached the server' : ''}`,
        );
      }
      users.push(lines.filter((line) => line.json).map((line) => JSON.parse(line.json).user));
    }

    console.log(`\n  the server got ${server.requests()} requests to /api/me`);

    const cached = bypassServiceWorker ? [] : await apiCache(page);
    if (!bypassServiceWorker) {
      console.log('  CacheStorage, api group:');
      console.log(cached.map((entry) => `    ${entry}`).join('\n') || '    (empty)');
    }

    return { users, requests: server.requests(), cached };
  } catch (error) {
    console.error(`\nServer output:\n${server.output()}`);
    throw error;
  } finally {
    await context.close();
    await server.stop();
  }
}

// What the worker kept for the `api` asset group.
function apiCache(page) {
  return page.evaluate(async () => {
    const entries = [];
    for (const name of await caches.keys()) {
      if (!name.endsWith(':assets:api:cache')) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        const { pathname, search } = new URL(req.url);
        const cacheControl = res.headers.get('cache-control');
        entries.push(`${pathname}${search}  cache-control: ${cacheControl}  ${await res.text()}`);
      }
    }
    return entries;
  });
}

async function startServer() {
  const child = spawn(process.execPath, ['backend/server.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let running = true;
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((done) => child.once('exit', done)).then(() => (running = false));

  // Wait until this server says it is listening, so another process on the port can't fool us.
  for (let attempt = 0; !output.includes(origin); attempt++) {
    if (!running || attempt === 100) throw new Error(`Server failed:\n${output}`);
    await new Promise((done) => setTimeout(done, 100));
  }

  return {
    output: () => output,
    requests: () => output.split('\n').filter((line) => line.includes(' GET /api/me')).length,
    stop: () => {
      child.kill();
      return exited;
    },
  };
}
