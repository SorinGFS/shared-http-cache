'use strict';
// utility for fetching multiple URLs with HTTP caching management
const cacache = require('cacache');
// cacache wrapper
class SharedHttpCache {
    constructor(options = {}) {
        Object.assign(this, { cacheDir: '.cache', awaitStorage: false, deferGarbageCollection: true, requestTimeoutMs: 5000 }, options);
        this.store = cacache;
    }
    async fetch(requests) {
        if (!Array.isArray(requests)) return Promise.reject([{ error: new TypeError('requests must be an array.') }]);
        const errors = [];
        const parseHeader = (string) => {
            if (!string || typeof string !== 'string') return {};
            const result = {};
            for (const part of string.split(',').reverse()) {
                const [key, value] = part.trim().split('=');
                result[key.toLocaleLowerCase()] = value === undefined ? true : Number.isNaN(+value) ? value : +value;
            }
            return result;
        };
        const isStale = (file, requestCacheControl = {}) => {
            const storedCacheControl = parseHeader(file.metadata.headers['cache-control']);
            const previousAge = Number(file.metadata.headers['age'] || 0);
            const currentAge = previousAge + (Date.now() - file.time) / 1000;
            let lifetime = 0; // Response freshness lifetime (s-maxage > max-age > Expires)
            if (storedCacheControl['s-maxage'] !== undefined) lifetime = storedCacheControl['s-maxage'];
            else if (storedCacheControl['max-age'] !== undefined) lifetime = storedCacheControl['max-age'];
            else {
                const expires = Date.parse(file.metadata.headers['expires'] || '');
                lifetime = !Number.isNaN(expires) ? Math.max(0, (expires - file.time) / 1000) : 0;
            }
            if (requestCacheControl['max-age'] !== undefined) lifetime = Math.min(lifetime, requestCacheControl['max-age']);
            const remainingLifetime = lifetime - currentAge;
            if (requestCacheControl['min-fresh'] !== undefined && remainingLifetime >= requestCacheControl['min-fresh']) return false;
            if (remainingLifetime >= 0) return false; // not stale
            return { lifetime, currentAge };
        };
        await Promise.all(
            requests.map(async (request, index) => {
                const { url, options = {}, integrity, callback } = request;
                if (typeof url !== 'string') return errors.push({ error: new Error('Malformed request, url undefined.'), index });
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs * Math.ceil(requests.length / 256));
                options.signal = controller.signal;
                if (!options.method) options.method = 'GET';
                if (!options.headers) options.headers = {};
                Object.keys(options.headers).forEach((key) => /\p{Lu}/u.test(key) && ((options.headers[key.toLowerCase()] = options.headers[key]), delete options.headers[key]));
                // prettier-ignore
                let response, buffer, headers, fromCache = true;
                try {
                    const requestCacheControl = parseHeader(options.headers['cache-control']);
                    const file = await this.store.get.info(this.cacheDir, url);
                    const isStaleFile = file && isStale(file, requestCacheControl); // unspecified max-stale → accept any staleness
                    const isAcceptedStaleFile = isStaleFile && requestCacheControl['max-stale'] && (requestCacheControl['max-stale'] === true || isStaleFile.currentAge <= isStaleFile.lifetime + requestCacheControl['max-stale']);
                    const storedCacheControl = file && parseHeader(file.metadata.headers['cache-control']);
                    const revalidate = storedCacheControl?.['must-revalidate'] || storedCacheControl?.['proxy-revalidate'];
                    const noCache = requestCacheControl['no-cache'] || storedCacheControl?.['no-cache'];
                    if (!file || (isStaleFile && !isAcceptedStaleFile) || (isAcceptedStaleFile && revalidate) || noCache) fromCache = false;
                    if (fromCache) {
                        buffer = integrity && !isAcceptedStaleFile ? await this.store.get.byDigest(this.cacheDir, integrity) : (await this.store.get(this.cacheDir, url)).data;
                        headers = file.metadata.headers;
                    } else {
                        if (requestCacheControl['only-if-cached']) throw new Error('HTTP error! status: 504 Only-If-Cached');
                        if (!file && integrity) options.integrity = integrity;
                        if (file && file.metadata.headers['etag']) options.headers['if-none-match'] = file.metadata.headers['etag'];
                        if (file && file.metadata.headers['last-modified']) options.headers['if-modified-since'] = file.metadata.headers['last-modified'];
                        response = await fetch(url, options);
                        if (response.status === 304) {
                            buffer = (await this.store.get(this.cacheDir, url)).data;
                            headers = { ...file.metadata.headers, ...Object.fromEntries(response.headers.entries()) };
                        } else if (response.ok) {
                            buffer = Buffer.from(await response.arrayBuffer());
                            headers = Object.fromEntries(response.headers.entries());
                        } else {
                            if (file && response.status === 410) {
                                this.store.rm.entry(this.cacheDir, url, { removeFully: true });
                                this.store.rm.content(this.cacheDir, file.integrity);
                            }
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                    }
                    // chance to preform content inspection before storage
                    if (typeof callback === 'function') callback({ buffer, headers, fromCache, index });
                    if (!fromCache) {
                        const responseCacheControl = parseHeader(headers['cache-control']);
                        if (options.method !== 'GET' || parseHeader(headers['vary'])['*']) return;
                        if (responseCacheControl['no-store'] || responseCacheControl['private']) return;
                        if (requestCacheControl['no-store'] || options.headers['authorization']) return;
                        const store = async () => {
                            if (!this.deferGarbageCollection) await this.store.rm.entry(this.cacheDir, url, { removeFully: true });
                            if (file && integrity && file.integrity !== integrity) this.store.rm.content(this.cacheDir, file.integrity);
                            await this.store.put(this.cacheDir, url, buffer, integrity ? { metadata: { headers }, integrity, algorithms: [integrity.split('-')[0]] } : { metadata: { headers } });
                        };
                        this.awaitStorage ? await store() : store();
                    }
                } catch (error) {
                    errors.push({ url, headers, error, index });
                } finally {
                    clearTimeout(timeout);
                }
            }),
        );
        return errors.length ? Promise.reject(errors) : Promise.resolve(this);
    }
}
// export
module.exports = SharedHttpCache;
