// Cross-origin isolation for hosts that cannot send response headers (GitHub Pages).
//
// WASM threads need SharedArrayBuffer, which a page only gets when it is served with
//   Cross-Origin-Opener-Policy: same-origin  and  Cross-Origin-Embedder-Policy: require-corp.
// This worker sits in front of every request of the page and adds the two headers to the responses, so after
// one reload the page is "crossOriginIsolated". It stores nothing, it changes no body, and where the host
// already sends the headers (the demo's own server) the page never registers it. See the bootstrap in index.html.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // a Chrome quirk: a request with cache "only-if-cached" and a mode other than "same-origin" throws when fetched
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // opaque (no-cors cross-origin) and opaque-redirect responses cannot be rebuilt; pass them through
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      })
      .catch((error) => {
        // a network failure must look like one to the page, not like a broken worker
        console.error("[coi-sw]", error);
        return Response.error();
      }),
  );
});
