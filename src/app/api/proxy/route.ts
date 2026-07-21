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

  // Inject random IP headers to bypass CDN IP-blocks on Netlify AWS nodes
  const randomIP = `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  headers.set('X-Forwarded-For', randomIP);
  headers.set('X-Real-IP', randomIP);
  headers.set('True-Client-IP', randomIP);
  headers.set('CF-Connecting-IP', randomIP);

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
