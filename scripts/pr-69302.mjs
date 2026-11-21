// The change from https://github.com/angular/angular/pull/69302, applied to the
// ngsw-worker.js that `ng build` copies from @angular/service-worker 22.3.0.
import { readFile, writeFile } from 'node:fs/promises';

const edits = [
  // New helper.
  [
    `  var AssetGroup = class {`,
    `  var UNCACHEABLE_CACHE_CONTROL_DIRECTIVES = new Set(["no-store", "private", "no-cache"]);
  function hasUncacheableCacheControl(headers) {
    const cacheControl = headers.get("cache-control");
    if (!cacheControl) {
      return false;
    }
    return cacheControl.split(",").some((directive) => {
      const directiveName = directive.split("=", 1)[0].trim().toLowerCase();
      return UNCACHEABLE_CACHE_CONTROL_DIRECTIVES.has(directiveName);
    });
  }
  var AssetGroup = class {`,
  ],

  // handleFetch(): evict a cached no-store / no-cache / private copy instead of serving it.
  [
    `          } else {
            if (await this.needToRevalidate(req, cachedResponse)) {`,
    `          } else if (hasUncacheableCacheControl(cachedResponse.headers)) {
            await this.removeCachedResource(req, cache);
          } else {
            if (await this.needToRevalidate(req, cachedResponse)) {`,
  ],

  // fetchAndCacheOnce(): only dedupe hashed resources...
  [
    `    async fetchAndCacheOnce(req, used = true) {
      if (this.inFlightRequests.has(req.url)) {
        return this.inFlightRequests.get(req.url);
      }
      const fetchOp = this.fetchFromNetwork(req);
      this.inFlightRequests.set(req.url, fetchOp);`,
    `    async fetchAndCacheOnce(req, used = true) {
      const url = this.adapter.normalizeUrl(req.url);
      const shouldDeduplicate = this.hashes.has(url);
      if (shouldDeduplicate && this.inFlightRequests.has(req.url)) {
        return this.inFlightRequests.get(req.url);
      }
      const fetchOp = this.fetchFromNetwork(req);
      if (shouldDeduplicate) {
        this.inFlightRequests.set(req.url, fetchOp);
      }`,
  ],
  [
    `        this.inFlightRequests.delete(req.url);`,
    `        if (shouldDeduplicate) {
          this.inFlightRequests.delete(req.url);
        }`,
  ],

  // ...and don't store unhashed no-store / no-cache / private responses.
  [
    `          const cache = await this.cache;
          await cache.put(req, res.clone());`,
    `          const cache = await this.cache;
          if (!this.hashes.has(url) && hasUncacheableCacheControl(res.headers)) {
            await this.removeCachedResource(req, cache);
            return res;
          }
          await cache.put(req, res.clone());`,
  ],
  [
    `    async fetchFromNetwork(req, redirectLimit = 3) {`,
    `    async removeCachedResource(req, cache) {
      await cache.delete(req, this.config.cacheQueryOptions);
      const metaTable = await this.metadata;
      await metaTable.delete(req.url);
    }
    async fetchFromNetwork(req, redirectLimit = 3) {`,
  ],

  // PrefetchAssetGroup: don't carry such responses over from a previous version.
  [
    `          await cache.put(req, res.response);`,
    `          if (hasUncacheableCacheControl(res.response.headers)) {
            return;
          }
          await cache.put(req, res.response);`,
  ],
];

const lf = (text) => text.replace(/\r\n/g, '\n');

export async function applyPr69302(file) {
  let source = await readFile(file, 'utf8');
  if (source.includes('hasUncacheableCacheControl')) return;

  for (const [before, after] of edits.map((edit) => edit.map(lf))) {
    const matches = source.split(before).length - 1;
    if (matches !== 1) throw new Error(`Expected 1 match in ${file}, got ${matches}:\n${before}`);
    source = source.replace(before, () => after);
  }

  await writeFile(file, source);
}
