interface FetchRequest {
    /** Request URL. */
    url: string;
    /** Resource integrity. */
    integrity?: string;
    /** Request init options [MDN reference](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit) */
    options?: RequestInit;
    /** Callback function. */
    callback?: (response: {
        /** Response buffer. */
        buffer: Buffer;
        /** Response headers [MDN reference](https://developer.mozilla.org/en-US/docs/Web/API/Headers) */
        headers: Headers;
        /** Is response from cache? */
        fromCache: boolean;
        /** Request index. */
        index: number;
    }) => void;
}
declare class SharedHttpCache {
    constructor(options?: {
        /** Cache directory (default: ".cache") */
        cacheDir?: string;
        /** Await storage (default: false) */
        awaitStorage?: boolean;
        /** Optional properties */
        [key: string]: any;
    });
    /** Cache directory path (default: ".cache") */
    readonly cacheDir: string;
    /** Await storage (default: false) */
    readonly awaitStorage: boolean;
    /** Fetch multiple requests (async).*/
    fetch(requests: readonly FetchRequest[]): Promise<this>;
    /** Storage management */
    readonly store: typeof import('cacache');
}

export = SharedHttpCache;
