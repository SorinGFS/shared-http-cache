'use strict';
// utility for fetching multiple URLs with HTTP caching management
const cacache = require('cacache');
// cacache wrapper
class SharedHttpCache {
    constructor(options = {}) {
        Object.assign(this, { cacheDir: '.cache', awaitStorage: false }, options);
        this.store = cacache;
    }
    /**
     * Fetch multiple resources with HTTP cache support.
     * @param {Array<{url:string,integrity?:string,options?:RequestInit,callback:(result:{buffer:Buffer,headers:Headers,fromCache:boolean})=>void}>} requests
     * @returns {Promise<this|{url: string, headers?: Headers, error: Error }[]>}
     * @see [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit), [Headers](https://developer.mozilla.org/en-US/docs/Web/API/Headers) MDN references
     */
    async fetch(requests) {
        const errors = [];
        const parseHeader = (string) => {
            if (!string || typeof string !== 'string') return {};
            const result = {};
            for (const part of string.split(',').reverse()) {
                const [key, value] = part.trim().split('=');
                result[key] = value === undefined ? true : Number.isNaN(+value) ? value : +value;
            }
            return result;
        };
        const isFresh = (file, requestCacheControl = {}) => {
            const storedCacheControl = parseHeader(file.metadata.headers['cache-control']);
            const previousAge = Number(file.metadata.headers['age'] || 0);
            const currentAge = previousAge + (Date.now() - file.time) / 1000;
            let lifetime; // Response freshness lifetime (s-maxage > max-age > Expires)
            if (storedCacheControl['s-maxage'] !== undefined) lifetime = storedCacheControl['s-maxage'];
            else if (storedCacheControl['max-age'] !== undefined) lifetime = storedCacheControl['max-age'];
            else {
                const expires = Date.parse(file.metadata.headers['expires'] || '');
                lifetime = !Number.isNaN(expires) ? Math.max(0, (expires - file.time) / 1000) : 0;
            }
            if (requestCacheControl['max-age'] !== undefined) lifetime = Math.min(lifetime, requestCacheControl['max-age']);
            const remainingLifetime = lifetime - currentAge;
            if (requestCacheControl['min-fresh'] !== undefined && remainingLifetime < requestCacheControl['min-fresh']) return false;
            if (remainingLifetime >= 0) return true; // not stale
            const maxStale = requestCacheControl['max-stale'];
            if (maxStale !== undefined) {
                if (maxStale === true) return true; // unspecified max-stale → accept any staleness
                if (currentAge <= lifetime + maxStale) return true;
            }
            return false;
        };
        await Promise.all(
            requests.map(async (request) => {
                const { url, options = {}, integrity, callback } = request;
                if (!options.method) options.method = 'GET';
                if (!options.headers) options.headers = {};
                Object.keys(options.headers).some((key) => key.toLowerCase() === 'cache-control' && (options.headers['cache-control'] = options.headers[key]));
                Object.keys(options.headers).some((key) => key.toLowerCase() === 'authorization' && (options.headers['authorization'] = options.headers[key]));
                // prettier-ignore
                let response, buffer, headers, fromCache = true;
                try {
                    const requestCacheControl = parseHeader(options.headers['cache-control']);
                    const file = await this.store.get.info(this.cacheDir, url);
                    const isFreshFile = file && isFresh(file, requestCacheControl);
                    if (file) {
                        const responseCacheControl = parseHeader(file.metadata.headers['cache-control']);
                        if (!isFreshFile && requestCacheControl['only-if-cached']) throw new Error('HTTP error! status: 504 Only-If-Cached');
                        if (!isFreshFile || requestCacheControl['no-cache'] || responseCacheControl['no-cache']) fromCache = false;
                        if (requestCacheControl['max-stale'] && (responseCacheControl['must-revalidate'] || responseCacheControl['proxy-revalidate'])) fromCache = false;
                        if (fromCache) {
                            buffer = (await this.store.get(this.cacheDir, url)).data;
                            headers = file.metadata.headers;
                        }
                    } else {
                        fromCache = false;
                        if (requestCacheControl['only-if-cached']) throw new Error('HTTP error! status: 504 Only-If-Cached');
                    }
                    if (!fromCache) {
                        if (file && file.metadata.headers['etag']) options.headers['if-none-match'] = file.metadata.headers['etag'];
                        if (file && file.metadata.headers['last-modified']) options.headers['if-modified-since'] = file.metadata.headers['last-modified'];
                        response = await fetch(url, options);
                        if (response.status === 304) {
                            buffer = (await this.store.get(this.cacheDir, url)).data;
                            headers = { ...file.metadata.headers, ...Object.fromEntries(response.headers.entries()) };
                            fromCache = true;
                        } else if (response.ok) {
                            buffer = Buffer.from(await response.arrayBuffer());
                            headers = Object.fromEntries(response.headers.entries());
                        } else {
                            if (response.status === 410) {
                                this.store.rm.entry(this.cacheDir, url, { removeFully: true });
                                this.store.rm.content(this.cacheDir, file.integrity);
                            }
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                    }
                    // chance to preform content validation before saving it to disk
                    if (typeof callback === 'function') callback({ buffer, headers, fromCache });
                    if (!fromCache || response?.status === 304) {
                        const responseCacheControl = parseHeader(headers['cache-control']);
                        if (options.method !== 'GET') return;
                        if (responseCacheControl['no-store'] || responseCacheControl['private']) return;
                        if (requestCacheControl['no-store'] || requestCacheControl['authorization']) return;
                        const store = async () => {
                            await this.store.rm.entry(this.cacheDir, url, { removeFully: true });
                            await this.store.put(this.cacheDir, url, buffer, integrity ? { metadata: { headers }, integrity } : { metadata: { headers } });
                        };
                        this.awaitStorage ? await store() : store();
                    }
                } catch (error) {
                    errors.push({ url, headers, error });
                }
            }),
        );
        return errors.length ? Promise.reject(errors) : Promise.resolve(this);
    }
}
// export
module.exports = SharedHttpCache;
