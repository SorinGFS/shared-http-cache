sharedHttpCache.fetch(requests).catch((errors) => errors.forEach((entry) => console.error(entry.url, entry.error)));
