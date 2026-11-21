import { HttpClient } from '@angular/common/http';
import { Component, VERSION, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

// What /api/me returns. `request` is the server's count of /api/me requests.
interface Me {
  user: string | null;
  email?: string;
  request: number;
}

interface Options {
  credentials?: RequestCredentials;
  cache?: RequestCache;
}

interface Line {
  text: string;
  json?: string;
  repeat?: boolean;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly http = inject(HttpClient);
  private readonly seen = new Set<number>();

  protected readonly version = VERSION.full;
  protected readonly worker = signal(navigator.serviceWorker?.controller ? 'active' : 'not active');
  protected readonly status = signal('Ready');
  protected readonly lines = signal<Line[]>([]);

  constructor() {
    navigator.serviceWorker?.addEventListener('controllerchange', () => this.worker.set('active'));
  }

  // alice logs out, the app asks again without cookies and without cache, then bob logs in.
  protected caseOne(): Promise<void> {
    const anonymous: Options = { credentials: 'omit', cache: 'no-store' };
    const steps = [
      () => this.post('/auth/login', { user: 'alice' }),
      () => this.get('/api/me'),
      () => this.post('/auth/logout'),
      () => this.get('/api/me', anonymous),
      () => this.post('/auth/login', { user: 'bob' }),
      () => this.get('/api/me'),
    ];

    return this.run(1, async () => {
      for (const [i, step] of steps.entries()) {
        if (i > 0) await sleep(2000);
        await step();
      }
    });
  }

  // Two requests for a URL that is not cached yet, the second one without cookies.
  protected caseTwo(): Promise<void> {
    return this.run(2, async () => {
      const url = `/api/me?race=${Date.now()}`;

      await this.post('/auth/login', { user: 'alice' });
      const first = this.me(url);
      await sleep(50); // the first one is still in flight
      const second = this.me(url, { credentials: 'omit' });
      this.show(url, {}, await first);
      this.show(url, { credentials: 'omit' }, await second);
    });
  }

  private me(url: string, options: Options = {}): Promise<Me> {
    return firstValueFrom(this.http.get<Me>(url, options));
  }

  private async get(url: string, options: Options = {}): Promise<void> {
    this.show(url, options, await this.me(url, options));
  }

  private async post(url: string, body: object | null = null): Promise<void> {
    await firstValueFrom(this.http.post(url, body));
    const text = `POST ${url}${body ? ` ${JSON.stringify(body)}` : ''}`;
    this.lines.update((lines) => [...lines, { text }]);
  }

  private show(url: string, options: Options, me: Me): void {
    const init = Object.entries(options)
      .map(([key, value]) => `${key}: '${value}'`)
      .join(', ');
    // A request number we already got means the server never saw this request.
    const repeat = this.seen.has(me.request);
    this.seen.add(me.request);

    const text = `GET ${url}${init ? ` { ${init} }` : ''}`;
    this.lines.update((lines) => [...lines, { text, json: JSON.stringify(me), repeat }]);
  }

  private async run(n: number, steps: () => Promise<void>): Promise<void> {
    this.status.set(`Running case ${n}`);
    this.lines.set([]);
    this.seen.clear();
    try {
      await steps();
      this.status.set(`Case ${n} done`);
    } catch (error) {
      this.status.set(`Error: ${(error as Error).message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
