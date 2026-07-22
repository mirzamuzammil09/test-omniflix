import { NextRequest, NextResponse } from 'next/server';
import http2 from 'http2';
import http from 'http';
import https from 'https';
import tls from 'tls';
import { Readable } from 'stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const DEFAULT_EXTERNAL_PROXY_URL = "https://boredflix-mp4-proxy-v2.abdouphphtml.workers.dev/m3u8-proxy";

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

async function fetchStreamWithProxyRotation(
  targetUrl: string,
  headersRecord: Record<string, string>,
  signal?: AbortSignal
): Promise<{ status: number; headers: Headers; body: ReadableStream } | null> {
  const parsed = new URL(targetUrl);
  const targetHost = parsed.hostname;
  const targetPath = parsed.pathname + parsed.search;

  for (const proxyStr of fallbackProxiesPool) {
    if (signal?.aborted) break;
    const [host, portStr] = proxyStr.split(":");
    const port = parseInt(portStr, 10);
    try {
      const res = await new Promise<{ status: number; headers: Headers; body: ReadableStream }>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("Aborted"));

        const connectReq = http.request({
          host,
          port,
          method: "CONNECT",
          path: `${targetHost}:443`,
          timeout: 4000
        });

        connectReq.on("connect", (cRes, socket) => {
          if (cRes.statusCode === 200) {
            const tlsSocket = tls.connect({
              host: targetHost,
              socket,
              servername: targetHost,
              rejectUnauthorized: false
            }, () => {
              const reqHeaders: Record<string, string> = {
                "host": targetHost,
                "user-agent": headersRecord["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "accept": "*/*",
                "referer": "https://netfilm.world/",
                "origin": "https://netfilm.world"
              };
              if (headersRecord["range"]) {
                reqHeaders["range"] = headersRecord["range"];
              }
              const req = https.request({
                host: targetHost,
                path: targetPath,
                method: "GET",
                headers: reqHeaders
              }, (hRes) => {
                const status = hRes.statusCode || 200;
                if (status === 200 || status === 206) {
                  const resHeaders = new Headers();
                  for (const [k, v] of Object.entries(hRes.headers)) {
                    if (v !== undefined) {
                      if (Array.isArray(v)) v.forEach(val => resHeaders.append(k, val));
                      else resHeaders.set(k, String(v));
                    }
                  }
                  const webStream = Readable.toWeb(hRes) as ReadableStream;
                  resolve({ status, headers: resHeaders, body: webStream });
                } else {
                  reject(new Error(`Proxy response status ${status}`));
                }
              });
              req.on("error", reject);
              req.end();
            });
            tlsSocket.on("error", reject);
          } else {
            reject(new Error(`CONNECT status ${cRes.statusCode}`));
          }
        });
        connectReq.on("error", reject);
        connectReq.on("timeout", () => {
          connectReq.destroy();
          reject(new Error("Proxy timeout"));
        });
        connectReq.end();
      });

      if (res && (res.status === 200 || res.status === 206)) {
        return res;
      }
    } catch (err) {
      // try next proxy
    }
  }
  return null;
}

async function fetchStreamWithSingleProxy(
  targetUrl: string,
  proxyStr: string,
  headersRecord: Record<string, string>,
  signal?: AbortSignal
): Promise<{ status: number; headers: Headers; body: ReadableStream } | null> {
  const [host, portStr] = proxyStr.split(":");
  const port = parseInt(portStr, 10);
  const parsed = new URL(targetUrl);
  const targetHost = parsed.hostname;
  const targetPath = parsed.pathname + parsed.search;

  try {
    const res = await new Promise<{ status: number; headers: Headers; body: ReadableStream }>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Aborted"));

      const connectReq = http.request({
        host,
        port,
        method: "CONNECT",
        path: `${targetHost}:443`,
        timeout: 5000
      });

      connectReq.on("connect", (cRes, socket) => {
        if (cRes.statusCode === 200) {
          const tlsSocket = tls.connect({
            host: targetHost,
            socket,
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
            const req = https.request({
              host: targetHost,
              path: targetPath,
              method: "GET",
              headers: reqHeaders
            }, (hRes) => {
              const status = hRes.statusCode || 200;
              if (status === 200 || status === 206) {
                const resHeaders = new Headers();
                for (const [k, v] of Object.entries(hRes.headers)) {
                  if (v !== undefined) {
                    if (Array.isArray(v)) v.forEach(val => resHeaders.append(k, val));
                    else resHeaders.set(k, String(v));
                  }
                }
                const webStream = Readable.toWeb(hRes) as ReadableStream;
                resolve({ status, headers: resHeaders, body: webStream });
              } else {
                reject(new Error(`Proxy CONNECT status ${status}`));
              }
            });
            req.on("error", reject);
            req.end();
          });
          tlsSocket.on("error", reject);
        } else {
          reject(new Error(`CONNECT status ${cRes.statusCode}`));
        }
      });
      connectReq.on("error", reject);
      connectReq.on("timeout", () => {
        connectReq.destroy();
        reject(new Error("Proxy timeout"));
      });
      connectReq.end();
    });

    return res;
  } catch (err: any) {
    console.warn(`[Proxy Node] Single proxy ${proxyStr} failed:`, err?.message || err);
    return null;
  }
}

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
    let fetchStatus = 500;
    let responseHeaders = new Headers();
    let responseBody: ReadableStream | null = null;
    let fetchTextContent: string | null = null;

    // 0. If a specific proxy was passed (from stateful scraper), try it first to honor IP-bound signature
    if (specifiedProxy) {
      try {
        console.log(`[Proxy Node] Attempting stream fetch via stateful specified proxy: ${specifiedProxy}...`);
        const singleRes = await fetchStreamWithSingleProxy(targetUrl, specifiedProxy, headersRecord, request.signal);
        if (singleRes && (singleRes.status === 200 || singleRes.status === 206)) {
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
        fetchStatus = h2Res.status;
        responseHeaders = h2Res.headers;
        responseBody = h2Res.body;
      } catch (h2Err) {
        console.warn('[Proxy H2] HTTP/2 fetch failed, trying HTTP/1 fallback:', h2Err);
      }
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

    // 3. Fallback to proxy rotation if direct fetch returned 403, 429, 502 or failed
    if (!responseBody || fetchStatus === 429 || fetchStatus === 403 || fetchStatus === 502) {
      try {
        console.log(`[Proxy Node] Direct fetch status ${fetchStatus}. Attempting proxy rotation pool fallback...`);
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

