# Angular service worker serves `no-store` responses from its cache

PoC for `@angular/service-worker` 22.3.0. For URLs matched by an asset group's `urls`, the service worker:

1. Stores responses sent with `Cache-Control: no-store` and serves them to later requests for that URL, whatever their credentials. After Alice logs out, the next user on the same browser gets her response.
2. Dedupes in-flight requests by URL only, so a request with `credentials: 'omit'` can get the response of a request sent with the user's cookie at the same time.

The fix for [GHSA-95qp-cmmw-mgqv](https://github.com/angular/angular/security/advisories/GHSA-95qp-cmmw-mgqv) ([#68904](https://github.com/angular/angular/pull/68904)) makes the worker keep `credentials: 'omit'` and `cache` when it rebuilds the request for an asset group URL. That request is correct, but in both cases the worker answers without sending it.

## Setup

Plain `ng new` + `ng generate service-worker` on Angular 22.3.0. The only thing I added to `ngsw-config.json` is this group, which is precondition 2 of the advisory:

```json
{
  "name": "api",
  "installMode": "lazy",
  "updateMode": "lazy",
  "resources": { "urls": ["/api/**"] }
}
```

`backend/server.mjs` has a login that sets an `HttpOnly; SameSite=Strict` session cookie, a logout, and `GET /api/me`. That endpoint always answers with `Cache-Control: no-store, private` and `Vary: Cookie`, takes 300 ms, and includes `request`, the server's own count of `/api/me` requests. If the same number shows up twice, the second response didn't come from the server.

The app calls it with `HttpClient` (fetch is the default backend in v22):

```ts
this.http.get<Me>('/api/me', { credentials: 'omit', cache: 'no-store' });
```

## Case 1: after logout

Alice logs in and loads `/api/me`. She logs out and the app asks again without cookies and without cache. Then Bob logs in on the same browser.

Service worker bypassed:

```text
GET /api/me                                            -> {"user":"alice","email":"alice@example.test","request":1}
GET /api/me { credentials: 'omit', cache: 'no-store' } -> {"user":null,"request":2}
GET /api/me                                            -> {"user":"bob","email":"bob@example.test","request":3}
```

Service worker active:

```text
GET /api/me                                            -> {"user":"alice","email":"alice@example.test","request":1}
GET /api/me { credentials: 'omit', cache: 'no-store' } -> {"user":"alice","email":"alice@example.test","request":1}
GET /api/me                                            -> {"user":"alice","email":"alice@example.test","request":1}
```

The server answered once. The worker stored Alice's response even though it was `no-store`, and [`handleFetch()`](https://github.com/angular/angular/blob/v22.3.0/packages/service-worker/worker/src/assets.ts#L141-L164) returns it before it gets to the rebuilt request ([L168](https://github.com/angular/angular/blob/v22.3.0/packages/service-worker/worker/src/assets.ts#L168)). Bob's request has no options at all, so `credentials` and `cache` don't matter here: whoever asks next gets the stored copy. When the run ends, CacheStorage still has it, along with the response from case 2:

```text
/api/me  cache-control: no-store, private  {"user":"alice","email":"alice@example.test","request":1}
/api/me?race=...  cache-control: no-store, private  {"user":"alice","email":"alice@example.test","request":2}
```

## Case 2: two requests at once

Alice is logged in. The app requests a URL that isn't cached yet, `/api/me?race=<timestamp>`, and 50 ms later the same URL with `credentials: 'omit'`.

Service worker bypassed:

```text
GET /api/me?race=...                         -> {"user":"alice","email":"alice@example.test","request":4}
GET /api/me?race=... { credentials: 'omit' } -> {"user":null,"request":5}
```

Service worker active:

```text
GET /api/me?race=...                         -> {"user":"alice","email":"alice@example.test","request":2}
GET /api/me?race=... { credentials: 'omit' } -> {"user":"alice","email":"alice@example.test","request":2}
```

[`fetchAndCacheOnce()`](https://github.com/angular/angular/blob/v22.3.0/packages/service-worker/worker/src/assets.ts#L300-L316) keys in-flight requests by URL only, so the second request just waits for the first one and gets Alice's response. Its own request, with `credentials: 'omit'` set correctly by the fix, is never sent. Nothing needs to be cached for this one.

## Background

#68904 only changed [`newRequestWithMetadata()`](https://github.com/angular/angular/blob/v22.3.0/packages/service-worker/worker/src/assets.ts#L520-L549). That request is right when it's sent: in both cases the server never gets a cookie for the `credentials: 'omit'` request, because it never gets that request at all. What's left is in the two paths that answer without it.

The advisory notes that CacheStorage is governed by `ngsw-config.json` and `ngsw-bypass`, not `Request.cache`. Case 1 doesn't depend on `Request.cache` or `credentials`. What the worker ignores is the server's `Cache-Control: no-store`, and the docs say `urls` resources ["are cached according to their HTTP headers"](https://angular.dev/ecosystem/service-workers/config). `no-store` means a cache [must not store the response](https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.5). `Vary: Cookie` doesn't help: asset groups always match with `ignoreVary: true` (`cacheQueryOptions` only accepts `ignoreSearch`), and requests in the worker don't carry the `Cookie` header anyway. The advisory's workaround, clearing the `ngsw:` caches on logout, is still needed after upgrading.

Case 2 doesn't come from CacheStorage. It's where the `credentials: 'omit'` request built by #68904 is created and then dropped. Since the key is only the URL, any other difference between the two requests, like `cache` or headers, is ignored too.

## Fix

[#69302](https://github.com/angular/angular/pull/69302) stops caching unhashed responses with `no-store`, `no-cache` or `private`, removes copies cached before, and only dedupes in-flight requests for hashed files. `npm run poc:fixed` applies it to the built `ngsw-worker.js` and runs the same test. The answers are then the same as with the worker bypassed, the server gets all 5 requests and the `api` cache stays empty.

## Run

```bash
npm ci
npm run poc        # published 22.3.0
npm run poc:fixed  # with #69302
```

`npm start` serves the app at http://127.0.0.1:4200 if you want to click through it. Wait until it says "Service worker: active". Case 1 waits 2 seconds between steps so you can follow it. Responses that never reached the server show up in red.
