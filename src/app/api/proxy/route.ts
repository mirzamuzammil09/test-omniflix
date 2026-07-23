import { NextRequest, NextResponse } from 'next/server';
import http2 from 'http2';
import http from 'http';
import https from 'https';
import tls from 'tls';
import { Readable } from 'stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const DEFAULT_EXTERNAL_PROXY_URL = "https://boredflix-mp4-proxy-v2.abdouphphtml.workers.dev/m3u8-proxy";

// Global process error handlers to prevent unhandled socket/stream errors from crashing Node.js
if (typeof process !== 'undefined') {
  process.on('uncaughtException', (err) => {
    console.error('[Proxy Process] Uncaught Exception caught:', err);
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Proxy Process] Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

const fallbackProxiesPool: string[] = [
  "93.77.191.156:8118",
  "176.111.37.216:39811",
  "149.18.81.114:7890",
  "85.237.39.139:8080",
  "160.238.65.7:3128",
  "95.211.174.135:3128",
  "2.59.43.253:22222",
  "45.153.4.154:3128",
  "188.127.224.164:2080",
  "185.191.239.248:3128",
  "94.158.49.82:3128",
  "160.238.65.4:3128",
  "93.185.68.82:8080",
  "154.17.8.103:1680",
  "20.83.140.251:8080"
];

function isNonVideoOrBlockPage(status: number, contentType: string): boolean {
  if (status !== 200 && status !== 206) return true;
  const lowerType = (contentType || '').toLowerCase();
  if (lowerType.includes('text/html') || (lowerType.includes('text/plain') && !lowerType.includes('m3u8'))) {
    return true;
  }
  return false;
}

function nodeToWebStream(
  stream: Readable,
  cleanupSockets?: () => void
): ReadableStream<Uint8Array> {
  let isCleanedUp = false;

  const doCleanup = (err?: any) => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    try {
      if ('destroy' in stream && typeof stream.destroy === 'function') {
        stream.destroy(err);
      }
    } catch (e) {}
    if (cleanupSockets) {
      try { cleanupSockets(); } catch (e) {}
    }
  };

  stream.on('error', (err) => {
    console.warn('[Proxy Stream Node Error]', err?.message || err);
    doCleanup(err);
  });

  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch (err) {
          doCleanup(err);
        }
      });

      stream.on('end', () => {
        try { controller.close(); } catch (e) {}
        doCleanup();
      });

      stream.on('error', (err) => {
        try { controller.error(err); } catch (e) {}
        doCleanup(err);
      });
    },
    cancel(reason) {
      console.warn('[Proxy Stream Canceled by Client]', reason);
      doCleanup();
    }
  });
}

async function fetchStreamWithSingleProxy(
  targetUrl: string,
  proxyStr: string,
  headersRecord: Record<string, string>,
  signal?: AbortSignal
): Promise<{ status: number; headers: Headers; body: ReadableStream } | null> {
  const [host, portStr] = proxyStr.split(":");
  const port = parseInt(portStr, 10);
  if (!host || isNaN(port)) return null;

  const parsed = new URL(targetUrl);
  const targetHost = parsed.hostname;
  const targetPath = parsed.pathname + parsed.search;

  return new Promise((resolve) => {
    let resolved = false;
    let connectReq: http.ClientRequest | null = null;
    let socket: any = null;
    let tlsSocket: any = null;
    let req: http.ClientRequest | null = null;
    let hRes: http.IncomingMessage | null = null;

    const cleanup = (err?: any) => {
      if (connectReq) { try { connectReq.destroy(); } catch (e) {} }
      if (req) { try { req.destroy(); } catch (e) {} }
      if (tlsSocket) { try { tlsSocket.destroy(); } catch (e) {} }
      if (socket) { try { socket.destroy(); } catch (e) {} }
      if (hRes) { try { hRes.destroy(); } catch (e) {} }
    };

    const safeResolve = (val: { status: number; headers: Headers; body: ReadableStream } | null) => {
      if (resolved) return;
      resolved = true;
      if (signalListener && signal) {
        signal.removeEventListener('abort', signalListener);
      }
      resolve(val);
    };

    const signalListener = () => {
      cleanup();
      safeResolve(null);
    };

    if (signal) {
      if (signal.aborted) {
        safeResolve(null);
        return;
      }
      signal.addEventListener('abort', signalListener, { once: true });
    }

    try {
      connectReq = http.request({
        host,
        port,
        method: "CONNECT",
        path: `${targetHost}:443`,
        timeout: 5000
      });

      connectReq.on("error", (err) => {
        cleanup(err);
        safeResolve(null);
      });

      connectReq.on("timeout", () => {
        cleanup();
        safeResolve(null);
      });

      connectReq.on("connect", (cRes, rawSocket) => {
        socket = rawSocket;

        socket.on("error", (err: any) => {
          console.warn(`[Proxy Raw Socket Error] ${host}:${port} -> ${targetHost}:`, err?.message || err);
          cleanup(err);
          safeResolve(null);
        });

        if (cRes.statusCode !== 200) {
          cleanup();
          safeResolve(null);
          return;
        }

        try {
          tlsSocket = tls.connect({
            host: targetHost,
            socket: socket,
            servername: targetHost,
            rejectUnauthorized: false
          }, () => {
            const reqHeaders: Record<string, string> = {
              "host": targetHost,
              "user-agent": headersRecord["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "accept": "*/*",
              "referer": headersRecord["referer"] || "https://netfilm.world/",
              "origin": headersRecord["origin"] || "https://netfilm.world"
            };
            if (headersRecord["range"]) {
              reqHeaders["range"] = headersRecord["range"];
            }

            try {
              req = https.request({
                host: targetHost,
                path: targetPath,
                method: "GET",
                headers: reqHeaders
              }, (responseStream) => {
                hRes = responseStream;

                hRes.on("error", (err) => {
                  console.warn(`[Proxy Response Stream Error] ${host}:${port} -> ${targetHost}:`, err?.message || err);
                  cleanup(err);
                  safeResolve(null);
                });

                const status = hRes.statusCode || 200;
                const contentType = hRes.headers["content-type"] || "";

                if (isNonVideoOrBlockPage(status, contentType)) {
                  console.warn(`[Proxy Single] Non-video or block page returned (status ${status}, type '${contentType}') from ${proxyStr}`);
                  cleanup();
                  safeResolve(null);
                  return;
                }

                const resHeaders = new Headers();
                for (const [k, v] of Object.entries(hRes.headers)) {
                  if (v !== undefined) {
                    if (Array.isArray(v)) v.forEach(val => resHeaders.append(k, val));
                    else resHeaders.set(k, String(v));
                  }
                }

                const webStream = nodeToWebStream(hRes, () => {
                  try { tlsSocket?.destroy(); } catch (e) {}
                  try { socket?.destroy(); } catch (e) {}
                  try { req?.destroy(); } catch (e) {}
                });

                safeResolve({ status, headers: resHeaders, body: webStream });
              });

              req.on("error", (err) => {
                console.warn(`[Proxy HTTPS Req Error] ${host}:${port} -> ${targetHost}:`, err?.message || err);
                cleanup(err);
                safeResolve(null);
              });

              req.end();
            } catch (err) {
              cleanup(err);
              safeResolve(null);
            }
          });

          tlsSocket.on("error", (err: any) => {
            console.warn(`[Proxy TLS Socket Error] ${host}:${port} -> ${targetHost}:`, err?.message || err);
            cleanup(err);
            safeResolve(null);
          });
        } catch (err) {
          cleanup(err);
          safeResolve(null);
        }
      });

      connectReq.end();
    } catch (err) {
      cleanup(err);
      safeResolve(null);
    }
  });
}

async function fetchStreamWithProxyRotation(
  targetUrl: string,
  headersRecord: Record<string, string>,
  signal?: AbortSignal
): Promise<{ status: number; headers: Headers; body: ReadableStream } | null> {
  for (const proxyStr of fallbackProxiesPool) {
    if (signal?.aborted) break;
    try {
      const res = await fetchStreamWithSingleProxy(targetUrl, proxyStr, headersRecord, signal);
      if (res) return res;
    } catch (err) {
      // try next proxy
    }
  }
  return null;
}

function fetchWithHttp2(
  targetUrl: string,
  headersObj: Record<string, string>,
  signal?: AbortSignal
): Promise<{ status: number; headers: Headers; body: ReadableStream } | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let client: http2.ClientHttp2Session | null = null;
    let req: http2.ClientHttp2Stream | null = null;

    const safeResolve = (val: { status: number; headers: Headers; body: ReadableStream } | null) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    const cleanup = () => {
      if (req) { try { req.destroy(); } catch (e) {} }
      if (client) { try { client.close(); } catch (e) {} }
    };

    if (signal) {
      if (signal.aborted) {
        safeResolve(null);
        return;
      }
      signal.addEventListener('abort', () => {
        cleanup();
        safeResolve(null);
      }, { once: true });
    }

    try {
      const parsedUrl = new URL(targetUrl);
      client = http2.connect(parsedUrl.origin);

      client.on('error', (err) => {
        console.warn('[Proxy H2 Session Error]', err?.message || err);
        cleanup();
        safeResolve(null);
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
        reqHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
      }
      if (!reqHeaders['accept']) {
        reqHeaders['accept'] = '*/*';
      }
      if (!reqHeaders['accept-language']) {
        reqHeaders['accept-language'] = 'en-US,en;q=0.9';
      }
      if (!reqHeaders['sec-ch-ua']) {
        reqHeaders['sec-ch-ua'] = '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"';
      }
      if (!reqHeaders['sec-ch-ua-mobile']) {
        reqHeaders['sec-ch-ua-mobile'] = '?0';
      }
      if (!reqHeaders['sec-ch-ua-platform']) {
        reqHeaders['sec-ch-ua-platform'] = '"Windows"';
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

      req = client.request(reqHeaders);

      req.on('error', (err) => {
        console.warn('[Proxy H2 Request Error]', err?.message || err);
        cleanup();
        safeResolve(null);
      });

      req.on('response', (headers) => {
        const status = Number(headers[':status']) || 200;
        const contentType = String(headers['content-type'] || '');

        if (isNonVideoOrBlockPage(status, contentType)) {
          console.warn(`[Proxy H2] Non-video or block page returned (status ${status}, content-type '${contentType}')`);
          cleanup();
          safeResolve(null);
          return;
        }

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

        const webStream = nodeToWebStream(req as any, () => {
          if (client) { try { client.close(); } catch (e) {} }
        });

        safeResolve({
          status,
          headers: resHeaders,
          body: webStream,
        });
      });

      req.end();
    } catch (err) {
      cleanup();
      safeResolve(null);
    }
  });
}

export async function GET(request: NextRequest) {
  const urlParams = new URL(request.url).searchParams;
  const targetUrl = urlParams.get('url');
  const headersStr = urlParams.get('headers');
  const specifiedProxy = urlParams.get('proxy');

  if (!targetUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }

  let headersRecord: Record<string, string> = {};
  let headers = new Headers();
  try {
    if (headersStr) {
      const parsed = JSON.parse(headersStr);
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) {
          const lowerKey = key.toLowerCase();
          headersRecord[lowerKey] = String(value);
          headers.set(lowerKey, String(value));
        }
      }
    }
  } catch (e) {
    // ignore
  }

  const isHakunayMatataTarget = targetUrl.includes('hakunaymatata.com') || targetUrl.includes('bcdnxw');

  if (isHakunayMatataTarget || !headersRecord['referer'] || headersRecord['referer'].includes('boredflix') || headersRecord['referer'] === 'https://netfilm.world') {
    headersRecord['referer'] = 'https://netfilm.world/';
    headers.set('referer', 'https://netfilm.world/');
  }
  if (isHakunayMatataTarget || !headersRecord['origin'] || headersRecord['origin'].includes('boredflix')) {
    headersRecord['origin'] = 'https://netfilm.world';
    headers.set('origin', 'https://netfilm.world');
  }
  if (!headersRecord['user-agent']) {
    headersRecord['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
    headers.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36');
  }

  // Forward range requests
  const range = request.headers.get('range');
  if (range) {
    headersRecord['range'] = range;
    headers.set('range', range);
  }

  try {
    let fetchStatus = 502;
    let responseHeaders = new Headers();
    let responseBody: ReadableStream | null = null;

    // 0. If a specific proxy was passed (from stateful scraper), try it first to honor IP-bound signature
    if (specifiedProxy) {
      try {
        console.log(`[Proxy Node] Attempting stream fetch via stateful specified proxy: ${specifiedProxy}...`);
        const singleRes = await fetchStreamWithSingleProxy(targetUrl, specifiedProxy, headersRecord, request.signal);
        if (singleRes) {
          console.log(`[Proxy Node] Stateful specified proxy ${specifiedProxy} SUCCEEDED (${singleRes.status})`);
          fetchStatus = singleRes.status;
          responseHeaders = singleRes.headers;
          responseBody = singleRes.body;
        }
      } catch (spErr) {
        console.warn(`[Proxy Node] Stateful specified proxy ${specifiedProxy} failed, falling back:`, spErr);
      }
    }

    // 1. Try HTTP/2 fetch if no successful response yet
    if (!responseBody) {
      try {
        const h2Res = await fetchWithHttp2(targetUrl, headersRecord, request.signal);
        if (h2Res) {
          fetchStatus = h2Res.status;
          responseHeaders = h2Res.headers;
          responseBody = h2Res.body;
        }
      } catch (h2Err) {
        console.warn('[Proxy H2] HTTP/2 fetch failed, trying HTTP/1 fallback:', h2Err);
      }
    }

    // 2. If HTTP/2 failed or returned non-video, attempt HTTP/1 fetch
    if (!responseBody) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const fetchRes = await fetch(targetUrl, {
            method: 'GET',
            headers,
            signal: request.signal,
          });

          const status = fetchRes.status;
          const contentType = fetchRes.headers.get('content-type') || '';

          if (!isNonVideoOrBlockPage(status, contentType) && fetchRes.body) {
            fetchStatus = status;
            responseHeaders = new Headers(fetchRes.headers);
            responseBody = fetchRes.body;
            break;
          }

          const shouldRetry = status === 429 || status === 403 || status === 502;
          if (!shouldRetry || attempt === 2) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
        } catch (h1Err) {
          console.warn(`[Proxy H1] Attempt ${attempt} failed:`, h1Err);
        }
      }
    }

    // 3. Fallback to proxy rotation if direct fetch returned 403, 429, 502 or failed
    if (!responseBody) {
      try {
        console.log(`[Proxy Node] Direct fetch unavailable. Attempting proxy rotation pool fallback...`);
        const rotatedRes = await fetchStreamWithProxyRotation(targetUrl, headersRecord, request.signal);
        if (rotatedRes) {
          fetchStatus = rotatedRes.status;
          responseHeaders = rotatedRes.headers;
          responseBody = rotatedRes.body;
        }
      } catch (rotErr) {
        console.error('[Proxy Node] Proxy rotation fallback failed:', rotErr);
      }
    }

    // 4. External proxy fallback if configured and still failing
    const isHakunayMatata = targetUrl.includes('hakunaymatata.com') || targetUrl.includes('bcdnxw');
    const externalProxyUrl = !isHakunayMatata ? (process.env.EXTERNAL_PROXY_URL || DEFAULT_EXTERNAL_PROXY_URL) : null;
    if (!responseBody && externalProxyUrl) {
      try {
        const proxyUrl = new URL(externalProxyUrl);
        proxyUrl.searchParams.set('url', targetUrl);
        if (headersStr) proxyUrl.searchParams.set('headers', headersStr);
        const proxyRes = await fetch(proxyUrl.toString(), { method: 'GET', signal: request.signal });
        const status = proxyRes.status;
        const contentType = proxyRes.headers.get('content-type') || '';
        if (!isNonVideoOrBlockPage(status, contentType) && proxyRes.body) {
          fetchStatus = status;
          responseHeaders = new Headers(proxyRes.headers);
          responseBody = proxyRes.body;
        }
      } catch (extErr) {
        console.error('[Proxy Node] External proxy fallback failed:', extErr);
      }
    }

    if (!responseBody) {
      return new NextResponse('Proxy stream unavailable or returned non-video content', {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        }
      });
    }

    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    // Remove headers that break HTML5 video streaming or cause browser attachment/CORS errors
    responseHeaders.delete('content-disposition');
    responseHeaders.delete('Content-Disposition');
    responseHeaders.delete('x-frame-options');
    responseHeaders.delete('X-Frame-Options');
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('transfer-encoding');

    if (fetchStatus >= 400) {
      responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    } else {
      responseHeaders.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    }

    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('mpegurl') || contentType.includes('application/vnd.apple.mpegurl') || targetUrl.includes('.m3u8')) {
      const reader = responseBody.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      } catch (readErr) {
        console.error('[Proxy M3U8 Read Error]', readErr);
        return new NextResponse('Failed to read M3U8 stream', { status: 502 });
      }

      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.trim().startsWith('<html') || text.trim().startsWith('<!DOCTYPE html') || text.includes('Just a moment...')) {
        return new NextResponse('Cloudflare block page received instead of M3U8 playlist', { status: 502 });
      }

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
    console.error("[Proxy Edge Error]", err?.message || err);
    return new NextResponse(err?.message || "Proxy stream error", { status: 502 });
  }
}
