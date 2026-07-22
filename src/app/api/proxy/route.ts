import { NextRequest, NextResponse } from 'next/server';
import http2 from 'http2';
import { Readable } from 'stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const DEFAULT_EXTERNAL_PROXY_URL = "https://omniflix.mgemers07.workers.dev";

function fetchWithHttp2(
  targetUrl: string,
  headersObj: Record<string, string>,
  signal?: AbortSignal
): Promise<{ status: number; headers: Headers; body: ReadableStream }> {
  return new Promise((resolve, reject) => {
    let client: http2.ClientHttp2Session | null = null;
    try {
      const parsedUrl = new URL(targetUrl);
      client = http2.connect(parsedUrl.origin);

      client.on('error', (err) => {
        if (client) {
          try { client.close(); } catch (e) {}
        }
        reject(err);
      });

      const reqHeaders: Record<string, string> = {
        ':path': parsedUrl.pathname + parsedUrl.search,
        ':method': 'GET',
        ':scheme': parsedUrl.protocol.replace(':', ''),
        ':authority': parsedUrl.host,
      };

      for (const [k, v] of Object.entries(headersObj)) {
        if (v !== undefined && v !== null && !k.startsWith(':')) {
          reqHeaders[k.toLowerCase()] = String(v);
        }
      }

      if (!reqHeaders['user-agent']) {
        reqHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
      }
      if (!reqHeaders['accept']) {
        reqHeaders['accept'] = '*/*';
      }
      if (!reqHeaders['accept-language']) {
        reqHeaders['accept-language'] = 'en-US,en;q=0.9';
      }
      if (!reqHeaders['sec-fetch-dest']) {
        reqHeaders['sec-fetch-dest'] = 'video';
      }
      if (!reqHeaders['sec-fetch-mode']) {
        reqHeaders['sec-fetch-mode'] = 'cors';
      }
      if (!reqHeaders['sec-fetch-site']) {
        reqHeaders['sec-fetch-site'] = 'cross-site';
      }

      const req = client.request(reqHeaders);

      if (signal) {
        if (signal.aborted) {
          req.destroy();
          try { client.close(); } catch (e) {}
          return reject(new Error('Request aborted'));
        }
        signal.addEventListener('abort', () => {
          req.destroy();
          if (client) {
            try { client.close(); } catch (e) {}
          }
        }, { once: true });
      }

      req.on('response', (headers) => {
        const status = Number(headers[':status']) || 200;
        const resHeaders = new Headers();

        for (const [k, v] of Object.entries(headers)) {
          if (!k.startsWith(':') && v !== undefined) {
            if (Array.isArray(v)) {
              v.forEach(val => resHeaders.append(k, val));
            } else {
              resHeaders.set(k, String(v));
            }
          }
        }

        const webStream = Readable.toWeb(req) as ReadableStream;

        req.on('end', () => {
          if (client) {
            try { client.close(); } catch (e) {}
          }
        });
        req.on('error', () => {
          if (client) {
            try { client.close(); } catch (e) {}
          }
        });

        resolve({
          status,
          headers: resHeaders,
          body: webStream,
        });
      });

      req.on('error', (err) => {
        if (client) {
          try { client.close(); } catch (e) {}
        }
        reject(err);
      });

      req.end();
    } catch (err) {
      if (client) {
        try { client.close(); } catch (e) {}
      }
      reject(err);
    }
  });
}

export async function GET(request: NextRequest) {
  const urlParams = new URL(request.url).searchParams;
  const targetUrl = urlParams.get('url');
  const headersStr = urlParams.get('headers');

  if (!targetUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }

  let headersRecord: Record<string, string> = {};
  let headers = new Headers();
  try {
    if (headersStr) {
      const parsed = JSON.parse(headersStr);
      for (const [key, value] of Object.entries(parsed)) {
        headersRecord[key] = value as string;
        headers.set(key, value as string);
      }
    }
  } catch (e) {
    // ignore
  }

  // Forward range requests
  const range = request.headers.get('range');
  if (range) {
    headersRecord['range'] = range;
    headers.set('range', range);
  }

  try {
    let fetchStatus = 500;
    let responseHeaders = new Headers();
    let responseBody: ReadableStream | null = null;
    let fetchTextContent: string | null = null;

    // 1. Try HTTP/2 fetch first (essential for Aliyun/Tengine CDNs that reject HTTP/1.1 with 429)
    try {
      const h2Res = await fetchWithHttp2(targetUrl, headersRecord, request.signal);
      fetchStatus = h2Res.status;
      responseHeaders = h2Res.headers;
      responseBody = h2Res.body;
    } catch (h2Err) {
      console.warn('[Proxy H2] HTTP/2 fetch failed, trying HTTP/1 fallback:', h2Err);
    }

    // 2. If HTTP/2 failed or returned 429/403/502, attempt HTTP/1 fetch
    if (!responseBody || fetchStatus === 429 || fetchStatus === 403 || fetchStatus === 502) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const fetchRes = await fetch(targetUrl, {
            method: 'GET',
            headers,
            signal: request.signal,
          });

          fetchStatus = fetchRes.status;
          responseHeaders = new Headers(fetchRes.headers);
          responseBody = fetchRes.body;

          const shouldRetry = fetchStatus === 429 || fetchStatus === 403 || fetchStatus === 502;
          if (!shouldRetry || attempt === 2) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
        } catch (h1Err) {
          console.warn(`[Proxy H1] Attempt ${attempt} failed:`, h1Err);
        }
      }
    }

    // 3. Fallback to external proxy if configured and upstream is blocking
    const externalProxyUrl = process.env.EXTERNAL_PROXY_URL || DEFAULT_EXTERNAL_PROXY_URL;
    if ((!responseBody || fetchStatus === 429 || fetchStatus === 403 || fetchStatus === 502) && externalProxyUrl) {
      try {
        const proxyUrl = new URL(externalProxyUrl);
        proxyUrl.searchParams.set('url', targetUrl);
        if (headersStr) proxyUrl.searchParams.set('headers', headersStr);
        const proxyRes = await fetch(proxyUrl.toString(), { method: 'GET', signal: request.signal });
        if (proxyRes.ok) {
          fetchStatus = proxyRes.status;
          responseHeaders = new Headers(proxyRes.headers);
          responseBody = proxyRes.body;
        }
      } catch (extErr) {
        console.error('[Proxy Node] External proxy fallback failed', extErr);
      }
    }

    if (!responseBody) {
      return new NextResponse('Proxy request failed', {
        status: fetchStatus || 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        }
      });
    }

    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');

    if (fetchStatus >= 400) {
      responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    } else {
      responseHeaders.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    }

    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('mpegurl') || contentType.includes('application/vnd.apple.mpegurl') || targetUrl.includes('.m3u8')) {
      const reader = responseBody.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString('utf-8');
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
        status: fetchStatus,
        headers: responseHeaders
      });
    }

    return new NextResponse(responseBody, {
      status: fetchStatus,
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

