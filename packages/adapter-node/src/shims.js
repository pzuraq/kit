import { fetch, Response, Request, Headers } from '@sveltejs/kit/install-fetch';

if (!globalThis.fetch) {
	// @ts-expect-error
	globalThis.fetch = fetch;
	// @ts-expect-error
	globalThis.Response = Response;
	// @ts-expect-error
	globalThis.Request = Request;
	globalThis.Headers = Headers;
}
