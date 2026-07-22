addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  try {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    const headersStr = url.searchParams.get('headers');

    if (!target) {
      return new Response('Missing url parameter', { status: 400 });
    }

    let forwardedHeaders = {};
    try {
      if (headersStr) forwardedHeaders = JSON.parse(headersStr);
    } catch (e) {
      // ignore parse errors
    }

    // Handle OPTIONS preflight quickly without forwarding to target
    if (request.method === 'OPTIONS') {
      const preflight = new Headers();
      preflight.set('Access-Control-Allow-Origin', '*');
      preflight.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      preflight.set('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
      preflight.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers: preflight });
    }

    // Filter out hop-by-hop headers before forwarding
    const hopByHop = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'
    ]);
    const forwarded = new Headers();
    for (const [k, v] of Object.entries(forwardedHeaders)) {
      if (!k) continue;
      const lower = k.toLowerCase();
      if (hopByHop.has(lower)) continue;
      try { forwarded.set(k, String(v)); } catch (e) { /* ignore */ }
    }

    if (!forwarded.has('user-agent')) {
      forwarded.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36');
    }
    if (!forwarded.has('origin')) {
      forwarded.set('origin', 'https://netfilm.world');
    }
    if (!forwarded.has('referer')) {
      forwarded.set('referer', 'https://netfilm.world/');
    }

    // Build fetch init
    const init = {
      method: request.method,
      headers: forwarded,
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
      redirect: 'follow',
    };

    // Allow range header passthrough from original client
    const range = request.headers.get('range');
    if (range) forwarded.set('range', range);

    const res = await fetch(target, init);

    // Clone headers and set CORS
    const responseHeaders = new Headers(res.headers || {});
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    // For OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(String(err?.message || err || 'Proxy error'), { status: 502 });
  }
}
