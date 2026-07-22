import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const urlParams = new URL(request.url).searchParams;
  const targetUrl = urlParams.get('url');
  const headersStr = urlParams.get('headers');

  if (!targetUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }

  let headers = new Headers();
  try {
    if (headersStr) {
      const parsed = JSON.parse(headersStr);
      for (const [key, value] of Object.entries(parsed)) {
        headers.set(key, value as string);
      }
    }
  } catch (e) {
    // ignore
  }

  // Removed random IP headers as Cloudflare blocks spoofed CF-Connecting-IP headers

  // Forward range requests
  const range = request.headers.get('range');
  if (range) {
    headers.set('range', range);
  }

  try {
    const fetchRes = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: request.signal,
    });

    // If upstream is rate-limiting or blocking (429/403/502), try delegating to EXTERNAL_PROXY_URL.
    // If none is configured, fall back to the built-in worker proxy used by the playback route.
    if (fetchRes.status === 429 || fetchRes.status === 403 || fetchRes.status === 502) {
      const externalProxyUrl = process.env.EXTERNAL_PROXY_URL || 'https://omniflix.mgemers07.workers.dev';
      try {
        const proxyUrl = new URL(externalProxyUrl);
        proxyUrl.searchParams.set('url', targetUrl);
        if (headersStr) proxyUrl.searchParams.set('headers', headersStr);
        const proxyRes = await fetch(proxyUrl.toString(), { method: 'GET', signal: request.signal });
        const proxyHeaders = new Headers(proxyRes.headers);
        proxyHeaders.set('Access-Control-Allow-Origin', '*');
        proxyHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        return new NextResponse(proxyRes.body, { status: proxyRes.status, headers: proxyHeaders });
      } catch (e) {
        console.error('[Proxy Edge] External proxy fallback failed', e);
        // fall through to return original fetchRes below
      }
    }

    const responseHeaders = new Headers(fetchRes.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');

    const contentType = fetchRes.headers.get('content-type') || '';
    if (contentType.includes('mpegurl') || contentType.includes('application/vnd.apple.mpegurl') || targetUrl.includes('.m3u8')) {
      const text = await fetchRes.text();
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) {
          let segmentUrl = line;
          if (!line.startsWith('http')) {
             segmentUrl = new URL(line, targetUrl).href;
          }
          const proxyUrl = new URL(request.url);
          proxyUrl.searchParams.set('url', segmentUrl);
          if (headersStr) proxyUrl.searchParams.set('headers', headersStr);
          lines[i] = proxyUrl.href;
        }
      }
      return new NextResponse(lines.join('\n'), {
        status: fetchRes.status,
        headers: responseHeaders
      });
    }

    return new NextResponse(fetchRes.body, {
      status: fetchRes.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    if (err.name === 'AbortError' || err.message?.includes('abort') || err.message?.includes('ResponseAborted')) {
      return new NextResponse(null, { status: 499 }); // Client Closed Request
    }
    console.error("[Proxy Edge Error]", err);
    return new NextResponse(err.message, { status: 500 });
  }
}
