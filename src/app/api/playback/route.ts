import { NextRequest, NextResponse } from "next/server";
import { tmdb } from "@/services/tmdb";
import https from "https";
import http from "http";
import tls from "tls";

const logDebug = (msg: string) => {
  console.log(`[Playback-Debug] ${msg}`);
};

const cleanTitle = (title: string): string => {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\[[^\]]*\]/g, "") // Remove brackets e.g. [Hindi]
    .replace(/\([^)]*\)/g, "") // Remove parentheses
    .replace(/\bs\d+-s\d+\b/g, "") // Remove season range e.g. s1-s4
    .replace(/\bs\d+\b/g, "") // Remove season tag e.g. s1
    .replace(/\bseason\s*\d+\b/g, "") // Remove season tags
    .replace(/\b(19|20)\d{2}\b/g, "") // Remove years e.g. 2022
    .replace(/[-_/:|,\.\(\)\[\]]+/g, " ") // Replace hyphens, colons, punctuation with spaces
    .replace(/[^a-z0-9\s]/g, "") // Remove other non-alphanumeric characters
    .replace(/\s+/g, " ") // Normalize multiple spaces
    .trim();
};

const isExpired = (url?: string | null): boolean => {
  return false;
};

const cleanPlaybackHeaders = (headers: any): any => {
  if (!headers) return headers;
  const cleaned = { ...headers };
  for (const key of Object.keys(cleaned)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "referer") {
      cleaned[key] = "https://netfilm.world/";
    } else if (lowerKey === "origin") {
      cleaned[key] = "https://netfilm.world";
    }
  }
  return cleaned;
};

function extractRootAudioVersion(streamObj: any): any | null {
  if (!streamObj) return null;
  const subjectId = streamObj.subject_id;
  const detailPath = streamObj.detail_path;
  if (!subjectId || !detailPath) return null;

  let lang = "Original";
  const title = streamObj.moviebox_title || streamObj.title || "";
  const match = title.match(/\[([^\]]+)\]/);
  if (match && match[1]) {
    lang = match[1].trim();
  } else {
    const pathParts = detailPath.toLowerCase().split("-");
    const knownLangs = ["hindi", "english", "french", "spanish", "german", "portuguese", "russian", "arabic", "turkish", "korean", "japanese", "tamil", "telugu", "indonesian", "chinese"];
    const found = pathParts.find((part: string) => knownLangs.includes(part));
    if (found) {
      lang = found.charAt(0).toUpperCase() + found.slice(1);
    }
  }

  return {
    language: lang,
    kind: "dub",
    label: `${lang} (Primary)`,
    subject_id: subjectId.toString(),
    detail_path: detailPath,
    title: title || `Stream [${lang}]`
  };
}

// Keep a local in-memory cache of proxies so we don't fetch from proxyscrape on every single request
let cachedProxiesList: string[] = [];
let cachedProxiesTime = 0;
let lastWorkingProxy: string | null = null;

async function getFreeProxies(): Promise<string[]> {
  const now = Date.now();
  // Cache proxy list for 30 minutes
  if (cachedProxiesList.length > 0 && now - cachedProxiesTime < 30 * 60 * 1000) {
    return cachedProxiesList;
  }

  try {
    logDebug(`[Proxy] Fetching fresh free proxy list from proxyscrape...`);
    const res = await fetch("https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=2000&country=all&ssl=yes&anonymity=all");
    if (res.ok) {
      const text = await res.text();
      const list = text.split("\n").map(p => p.trim()).filter(Boolean);
      if (list.length > 0) {
        cachedProxiesList = list;
        cachedProxiesTime = now;
        logDebug(`[Proxy] Successfully cached ${list.length} proxies from proxyscrape`);
        return list;
      }
    }
  } catch (e: any) {
    logDebug(`[Proxy] Failed to fetch free proxy list from proxyscrape: ${e.message}`);
  }

  // Fallback to monosans github list to make it extremely resilient
  try {
    logDebug(`[Proxy] Fetching fallback proxy list from monosans github...`);
    const res = await fetch("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt");
    if (res.ok) {
      const text = await res.text();
      const list = text.split("\n").map(p => p.trim()).filter(Boolean);
      if (list.length > 0) {
        cachedProxiesList = list;
        cachedProxiesTime = now;
        logDebug(`[Proxy] Successfully cached ${list.length} proxies from monosans github`);
        return list;
      }
    }
  } catch (e: any) {
    logDebug(`[Proxy] Failed to fetch free proxy list from monosans: ${e.message}`);
  }

  return cachedProxiesList;
}

function decodeChunkedBody(bodyBuffer: Buffer): Buffer {
  let offset = 0;
  const chunks: Buffer[] = [];
  while (offset < bodyBuffer.length) {
    const crlfIndex = bodyBuffer.indexOf("\r\n", offset);
    if (crlfIndex === -1) break;
    const sizeStr = bodyBuffer.slice(offset, crlfIndex).toString("utf8").trim();
    if (!sizeStr) {
      offset = crlfIndex + 2;
      continue;
    }
    const chunkSize = parseInt(sizeStr, 16);
    if (isNaN(chunkSize)) {
      return bodyBuffer; // Fallback to original buffer if not chunked or parsing fails
    }
    if (chunkSize === 0) {
      break; // End of chunks
    }
    const dataStart = crlfIndex + 2;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bodyBuffer.length) {
      chunks.push(bodyBuffer.slice(dataStart));
      break;
    }
    chunks.push(bodyBuffer.slice(dataStart, dataEnd));
    offset = dataEnd + 2;
  }
  return Buffer.concat(chunks);
}

function requestWithProxy(urlStr: string, options: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let resolvedOrRejected = false;
    let abortHandler: (() => void) | null = null;
    let activeSocket: any = null;
    let activeTlsSocket: any = null;
    let connectReq: any = null;
    let req: any = null;

    const safeReject = (err: any) => {
      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      cleanup();
      reject(err);
    };

    const safeResolve = (val: any) => {
      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      cleanup();
      resolve(val);
    };

    const cleanup = () => {
      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    };

    abortHandler = () => {
      try {
        if (connectReq) connectReq.destroy();
        if (req) req.destroy();
        if (activeTlsSocket) {
          activeTlsSocket.destroy();
        } else if (activeSocket) {
          activeSocket.destroy();
        }
      } catch (e) {
        // ignore errors during destruction
      }
      safeReject(new Error("Request aborted"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
        return;
      }
      options.signal.addEventListener("abort", abortHandler);
    }

    try {
      const parsedUrl = new URL(urlStr);
      const proxyUrl = new URL(options.proxy);

      const proxyHost = proxyUrl.hostname;
      const proxyPort = parseInt(proxyUrl.port || "8080", 10);

      const targetHost = parsedUrl.hostname;
      const targetPort = parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80");

      if (parsedUrl.protocol === "https:") {
        const connectHeaders: any = {
          Host: `${targetHost}:${targetPort}`,
        };
        if (proxyUrl.username && proxyUrl.password) {
          connectHeaders["Proxy-Authorization"] = "Basic " + Buffer.from(proxyUrl.username + ":" + proxyUrl.password).toString("base64");
        }

        connectReq = http.request({
          host: proxyHost,
          port: proxyPort,
          method: "CONNECT",
          path: `${targetHost}:${targetPort}`,
          headers: connectHeaders,
          timeout: options.timeout || 5000,
        });

        connectReq.on("connect", (res: any, socket: any, head: any) => {
          activeSocket = socket;
          if (res.statusCode !== 200) {
            socket.destroy();
            safeReject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
            return;
          }

          if (options.signal?.aborted) {
            socket.destroy();
            return;
          }

          const tlsSocket = tls.connect({
            socket: socket,
            servername: targetHost,
            rejectUnauthorized: false,
          }, () => {
            if (options.signal?.aborted) {
              tlsSocket.destroy();
              return;
            }

            const headers = {
              Host: targetHost,
              Connection: "close",
              "Accept-Encoding": "identity",
              ...(options.headers || {}),
            };

            // Force host header to match target
            for (const key of Object.keys(headers)) {
              if (key.toLowerCase() === "host") {
                delete (headers as any)[key];
              }
            }

            const bodyStr = options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : "";
            if (bodyStr) {
              (headers as any)["Content-Length"] = Buffer.byteLength(bodyStr);
            }

            const reqLines = [
              `${options.method || "GET"} ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1`,
              `Host: ${targetHost}`,
              ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
              "",
              bodyStr
            ];

            tlsSocket.write(reqLines.join("\r\n"));
          });

          activeTlsSocket = tlsSocket;

          let rawResponse = Buffer.alloc(0);
          tlsSocket.on("data", (chunk: any) => {
            rawResponse = Buffer.concat([rawResponse, chunk]);
          });

          tlsSocket.on("end", () => {
            try {
              const boundary = rawResponse.indexOf(Buffer.from("\r\n\r\n"));
              if (boundary === -1) {
                safeReject(new Error("Invalid response from target over proxy"));
                return;
              }

              const headerPart = rawResponse.subarray(0, boundary).toString("utf8");
              let bodyPart: any = rawResponse.subarray(boundary + 4);

              const lines = headerPart.split("\r\n");
              const statusLine = lines[0];
              const statusCode = parseInt(statusLine.split(" ")[1] || "200", 10);

              const headers: Record<string, string> = {};
              for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                const colonIndex = line.indexOf(":");
                if (colonIndex !== -1) {
                  const key = line.slice(0, colonIndex).trim().toLowerCase();
                  const value = line.slice(colonIndex + 1).trim();
                  headers[key] = value;
                }
              }

              if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
                bodyPart = decodeChunkedBody(bodyPart);
              }

              const bodyStr = bodyPart.toString("utf8");

              // Validate that the body is valid JSON (since all playback endpoints return JSON)
              let isJson = false;
              try {
                const trimmed = bodyStr.trim();
                if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
                  JSON.parse(bodyStr);
                  isJson = true;
                }
              } catch (e) {}

              if (!isJson) {
                safeReject(new Error("Proxy returned invalid/non-JSON response (likely a Cloudflare block page or Gateway error)"));
                return;
              }

              safeResolve({
                ok: statusCode >= 200 && statusCode < 300,
                status: statusCode,
                json: async () => JSON.parse(bodyStr),
                text: async () => bodyStr,
              });
            } catch (err) {
              safeReject(err);
            }
          });

          tlsSocket.on("error", (err: any) => safeReject(err));
        });

        connectReq.on("error", (err: any) => safeReject(err));
        connectReq.on("timeout", () => {
          connectReq.destroy();
          safeReject(new Error("Proxy CONNECT Timeout"));
        });

        connectReq.end();
      } else {
        // HTTP fallback
        const reqOptions = {
          host: proxyHost,
          port: proxyPort,
          path: urlStr,
          method: options.method || "GET",
          headers: options.headers || {},
          timeout: options.timeout || 5000,
        };

        req = http.request(reqOptions, (res: any) => {
          let rawData = Buffer.alloc(0);
          res.on("data", (chunk: any) => { rawData = Buffer.concat([rawData, chunk]); });
          res.on("end", () => {
            try {
              let bodyPart: any = rawData;
              const headers: Record<string, string> = {};
              for (const [key, value] of Object.entries(res.headers)) {
                if (value) {
                  headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
                }
              }

              if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
                bodyPart = decodeChunkedBody(bodyPart);
              }

              const data = bodyPart.toString("utf8");

              // Validate that the body is valid JSON (since all playback endpoints return JSON)
              let isJson = false;
              try {
                const trimmed = data.trim();
                if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
                  JSON.parse(data);
                  isJson = true;
                }
              } catch (e) {}

              if (!isJson) {
                safeReject(new Error("Proxy returned invalid/non-JSON response (likely a Cloudflare block page or Gateway error)"));
                return;
              }

              safeResolve({
                ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                json: async () => JSON.parse(data),
                text: async () => data,
              });
            } catch (e) {
              safeReject(e);
            }
          });
        });

        req.on("error", (err: any) => safeReject(err));
        req.on("timeout", () => {
          req.destroy();
          safeReject(new Error("Proxy request timeout"));
        });
        if (options.body) req.write(options.body);
        req.end();
      }
    } catch (err) {
      safeReject(err);
    }
  });
}

async function fetchBoredflixWithFallback(url: string, options: any = {}): Promise<any> {
  const isServerless = 
    process.env.VERCEL === "1" || 
    process.env.NETLIFY === "true" ||
    process.env.NODE_ENV === "production" ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

  // 1. If we have a cached working proxy, try it first to avoid spawning parallel requests
  if (lastWorkingProxy) {
    try {
      logDebug(`[Proxy-Client] Trying cached working proxy: http://${lastWorkingProxy}`);
      const res = await requestWithProxy(url, {
        ...options,
        proxy: `http://${lastWorkingProxy}`,
        timeout: 2500,
      });
      if (res.ok) {
        logDebug(`[Proxy-Client] Cached working proxy http://${lastWorkingProxy} succeeded!`);
        return res;
      }
      logDebug(`[Proxy-Client] Cached working proxy http://${lastWorkingProxy} returned status: ${res.status}`);
      lastWorkingProxy = null; // Clear if it returns error/non-OK
    } catch (err: any) {
      logDebug(`[Proxy-Client] Cached working proxy http://${lastWorkingProxy} failed: ${err.message}`);
      lastWorkingProxy = null; // Clear on connection error
    }
  }

  // 2. Try Direct Fetch first
  // In serverless, we do a very quick direct fetch attempt (1.2s timeout).
  // If it succeeds (e.g. if Cloudflare bypasses or Vercel region is not blocked), we avoid proxying completely!
  // If it is blocked (returns 403 instantly) or times out (takes 1.2s), we fallback to proxy.
  const directTimeout = isServerless ? 1200 : 4500;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), directTimeout);
    const directOptions = { ...options, signal: controller.signal };

    logDebug(`[Proxy-Client] Attempting direct fetch to ${url} (Timeout: ${directTimeout}ms)...`);
    const res = await fetch(url, directOptions);
    clearTimeout(timer);

    if (res.ok) {
      logDebug(`[Proxy-Client] Direct fetch succeeded for ${url}`);
      return res;
    }

    if (res.status === 403) {
      logDebug(`[Proxy-Client] Direct fetch blocked (403) for ${url}. Switching to proxy fallback.`);
    } else {
      logDebug(`[Proxy-Client] Direct fetch returned status ${res.status} for ${url}. Switching to proxy fallback.`);
    }
  } catch (err: any) {
    logDebug(`[Proxy-Client] Direct fetch failed/timed out for ${url}: ${err.message}. Switching to proxy fallback.`);
  }

  // 3. Fallback to Proxy Rotation
  const proxies = await getFreeProxies();
  if (proxies.length === 0) {
    logDebug(`[Proxy-Client] No backup proxies available, throwing error`);
    throw new Error("No proxies available");
  }

  const shuffled = [...proxies].sort(() => 0.5 - Math.random());
  // Test fewer proxies in parallel on serverless to avoid saturating resources (10 instead of 15)
  const maxParallel = isServerless ? 10 : 15;
  const testProxies = shuffled.slice(0, maxParallel);
  logDebug(`[Proxy-Client] Testing ${testProxies.length} proxies in parallel for URL: ${url}`);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let completedCount = 0;
    const errors: any[] = [];
    const abortControllers: AbortController[] = [];

    // Safety timeout to ensure we return before execution limit (use 6.5s for serverless, 9s for local dev)
    const timeoutDuration = isServerless ? 6500 : 9000;
    const overallTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        abortControllers.forEach(ctrl => ctrl.abort());
        reject(new Error("All proxy attempts timed out (Overall Timeout)"));
      }
    }, timeoutDuration);

    testProxies.forEach((proxy) => {
      const controller = new AbortController();
      abortControllers.push(controller);

      requestWithProxy(url, {
        ...options,
        proxy: `http://${proxy}`,
        timeout: 4000,
        signal: controller.signal
      })
        .then((res: any) => {
          if (resolved) return;
          if (res.ok) {
            resolved = true;
            clearTimeout(overallTimeout);
            abortControllers.forEach(ctrl => ctrl.abort());
            logDebug(`[Proxy-Client] Parallel Proxy http://${proxy} succeeded!`);
            
            // Cache the successful proxy in memory for subsequent requests
            lastWorkingProxy = proxy;
            
            resolve(res);
          } else {
            throw new Error(`Non-OK status: ${res.status}`);
          }
        })
        .catch((err: any) => {
          errors.push(err);
        })
        .finally(() => {
          completedCount++;
          if (completedCount === testProxies.length && !resolved) {
            resolved = true;
            clearTimeout(overallTimeout);
            reject(new Error(`All ${testProxies.length} proxy attempts failed: ` + errors.map(e => e.message).join(", ")));
          }
        });
    });
  });
}

const verifyCDNUrl = async (url: string, headers: any): Promise<boolean> => {
  if (isExpired(url)) {
    logDebug(`[verifyCDNUrl] URL is expired: ${url}`);
    return false;
  }
  return true;
};

const clearBoredflixCache = async (
  id: string,
  contentType: string,
  serverNum: string,
  token: string,
  subjectId?: string,
  season?: string | number,
  episode?: string | number
) => {
  const tvParams = contentType === "tv" && season && episode ? `&season=${season}&episode=${episode}` : "";
  const cleanServer = serverNum.length === 1 ? `source_0${serverNum}` : `source_${serverNum}`;
  const clearUrl = `https://boredflix.cc/scrape/clear/${id}/${contentType === "tv" ? "tv" : "movie"}?server=${cleanServer}${subjectId ? `&subject_id=${subjectId}` : ""}${tvParams}`;
  try {
    logDebug(`[clearBoredflixCache] Clearing cache via url: ${clearUrl}`);
    await fetchBoredflixWithFallback(clearUrl, {
      method: "DELETE",
      headers: {
        "X-Bf-Client-Token": token,
        "Origin": "https://boredflix.cc",
        "Referer": "https://boredflix.cc/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
  } catch (err: any) {
    logDebug(`[clearBoredflixCache] Failed: ${err?.message || err}`);
  }
};

let cachedToken: string | null = null;
let cachedTokenTime: number = 0;

export async function POST(request: NextRequest) {
  // Hotlinking & Scraper Guard: Only allow requests originating from our own domain
  const referer = request.headers.get("referer");
  const origin = request.headers.get("origin");
  const hostHeader = request.headers.get("host") || "";
  const xForwardedHost = request.headers.get("x-forwarded-host") || "";
  
  const host = (xForwardedHost.split(",")[0] || hostHeader || "").split(":")[0].trim();
  const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1") || !host;

  if (!isLocalhost) {
    // If both referer and origin are missing, reject immediately to block direct script calling
    if (!referer && !origin) {
      logDebug(`[Guard] Blocked request from missing referer and origin headers (Host: ${host})`);
      return NextResponse.json({ error: "Unauthorized: API requests must originate from the website" }, { status: 403 });
    }

    if (referer) {
      try {
        const refererUrl = new URL(referer);
        const refererHost = refererUrl.hostname;
        const isDomainMatched = refererHost === host || 
                                refererHost.endsWith("." + host) || 
                                host.endsWith("." + refererHost);

        if (!isDomainMatched) {
          logDebug(`[Guard] Blocked request from referer ${refererHost} for host ${host}`);
          return NextResponse.json({ error: "Unauthorized: Hotlinking is forbidden" }, { status: 403 });
        }
      } catch (e) {
        return NextResponse.json({ error: "Invalid request source" }, { status: 400 });
      }
    }

    if (origin) {
      try {
        const originUrl = new URL(origin);
        const originHost = originUrl.hostname;
        const isDomainMatched = originHost === host || 
                                originHost.endsWith("." + host) || 
                                host.endsWith("." + originHost);

        if (!isDomainMatched) {
          logDebug(`[Guard] Blocked request from origin ${originHost} for host ${host}`);
          return NextResponse.json({ error: "Unauthorized: Cross-origin requests are forbidden" }, { status: 403 });
        }
      } catch (e) {
        return NextResponse.json({ error: "Invalid request source" }, { status: 400 });
      }
    }
  }

  try {
    const body = await request.json();
    const { id, subjectId, detailPath, server = "source_06", type = "movie", season, episode, forceRefresh } = body;

    logDebug(`POST request received. ID: ${id}, type: ${type}, server: ${server}, season: ${season}, episode: ${episode}, subjectId: ${subjectId}, detailPath: ${detailPath}, forceRefresh: ${forceRefresh}`);

    if (!id) {
      logDebug(`Error: TMDB ID is required`);
      return NextResponse.json({ error: "TMDB ID is required" }, { status: 400 });
    }

    let streamUrl: string | null = null;
    let audioVersions: any[] = [];
    let freshDubData: any = null;
    let subtitles: any[] = [];
    let qualities: { label: string; url: string }[] = [];
    let details = "";
    const isDubRequest = !!(subjectId && detailPath); // true when user explicitly selected a dub

    const serverNum = server.toLowerCase().includes("source_")
      ? server.toLowerCase().replace("source_", "").replace(/^0+/, "")
      : server;

    const contentType = type === "tv" ? "tv" : "movie";

    let mainTitle = "";
    try {
      if (contentType === "tv") {
        const showDetails = await tmdb.getTVDetails(id);
        mainTitle = showDetails.name || showDetails.original_name || "";
      } else {
        const movieDetails = await tmdb.getMovieDetails(id);
        mainTitle = movieDetails.title || movieDetails.original_title || "";
      }
    } catch (err) {
      console.warn(`[Proxy] Failed to fetch TMDB details for title filtering: ${err}`);
    }

    try {
      // 1. Get client token
      let token = cachedToken;
      const isTokenExpired = !cachedTokenTime || (Date.now() - cachedTokenTime > 10 * 60 * 1000);

      if (!token || isTokenExpired) {
        logDebug(`[Token] Fetching fresh client token...`);
        const tokenResponse = await fetchBoredflixWithFallback("https://boredflix.cc/api/v1/client-token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": "https://boredflix.cc",
            "Referer": "https://boredflix.cc/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({}),
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });

        if (!tokenResponse.ok) throw new Error(`Token fetch failed (HTTP ${tokenResponse.status})`);
        const tokenData = await tokenResponse.json();
        token = tokenData?.token;
        if (!token) throw new Error("No token in response");

        cachedToken = token;
        cachedTokenTime = Date.now();
        logDebug(`[Token] Cached token successfully`);
      } else {
        logDebug(`[Token] Reusing cached token`);
      }

      // If frontend requested a forced refresh, clear cache immediately
      if (forceRefresh) {
        logDebug(`[CDN Guard] Frontend forced refresh, clearing cache for TMDB ID: ${id}`);
        await clearBoredflixCache(id, contentType, serverNum, token, subjectId, season, episode);
      }

      let activeStream: any = null;
      let rawUrl: string | null = null;
      let playbackHeaders: any = null;
      qualities = [];

      let audioVersionsPromise: Promise<any> | null = null;
      if (!isDubRequest) {
        const tvAudioParams = contentType === "tv" ? `&season=${season}&episode=${episode}` : "";
        const audioVersionsUrl = `https://boredflix.cc/${serverNum}/aoneroom/audio-versions?tmdb_id=${id}&type=${contentType}${tvAudioParams}&_=${Date.now()}`;
        logDebug(`[Parallel Audio] Starting parallel fetch for: ${audioVersionsUrl}`);
        audioVersionsPromise = fetchBoredflixWithFallback(audioVersionsUrl, {
          headers: {
            "X-Bf-Client-Token": token,
            "Origin": "https://boredflix.cc",
            "Referer": "https://boredflix.cc/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(4000)
        })
          .then((res) => {
            if (res.ok) return res.json();
            logDebug(`[Parallel Audio] Response not OK: HTTP ${res.status}`);
            return null;
          })
          .catch((err) => {
            logDebug(`[Parallel Audio] Fetch failed or timed out: ${err?.message || err}`);
            return null;
          });
      }

      const tvParams = contentType === "tv" ? `&season=${season}&episode=${episode}` : "";

      // Helper: attempt the /version endpoint with a given subject_id + detail_path
      const tryVersionFetch = async (sid: string, dpath: string): Promise<boolean> => {
        const versionUrl = `https://boredflix.cc/${serverNum}/aoneroom/version?tmdb_id=${id}&subject_id=${sid}&detail_path=${dpath}&type=${contentType}${tvParams}&_=${Date.now()}`;
        logDebug(`[Dub] Fetching version: ${versionUrl}`);
        try {
          const versionRes = await fetchBoredflixWithFallback(versionUrl, {
            headers: {
              "X-Bf-Client-Token": token,
              "Origin": "https://boredflix.cc",
              "Referer": "https://boredflix.cc/",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(8000)
          });
          if (versionRes.ok) {
            const versionData = await versionRes.json();
            const dubUrl = versionData?.url || versionData?.m3u8_url || versionData?.quality_info?.hls_master_url;
            if (dubUrl) {
              activeStream = versionData;
              rawUrl = dubUrl;
              playbackHeaders = versionData.quality_info?.playback_headers;
              details = `Dub stream: ${dpath}`;
              logDebug(`[Dub] ✅ Got dub stream URL for ${dpath}`);
              return true;
            }
            logDebug(`[Dub] Version OK but no URL in response for ${dpath}`);
          } else {
            logDebug(`[Dub] Version HTTP ${versionRes.status} for ${dpath}`);
          }
        } catch (e: any) {
          logDebug(`[Dub] Version fetch error: ${e?.message}`);
        }
        return false;
      };

      // 2a. Dub version fetch (Option A) — with fresh-path retry on 502
      if (subjectId && detailPath) {
        const attempt1 = await tryVersionFetch(subjectId, detailPath);

        if (!attempt1) {
          logDebug(`[Dub] Attempt 1 failed. Fetching fresh audio-versions to find correct detail_path...`);
          try {
            const tvAudioParams = contentType === "tv" ? `&season=${season}&episode=${episode}` : "";
            const freshAvRes = await fetchBoredflixWithFallback(
              `https://boredflix.cc/${serverNum}/aoneroom/audio-versions?tmdb_id=${id}&type=${contentType}${tvAudioParams}&_=${Date.now()}`,
              {
                headers: {
                  "X-Bf-Client-Token": token,
                  "Origin": "https://boredflix.cc",
                  "Referer": "https://boredflix.cc/",
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
                cache: "no-store",
                signal: AbortSignal.timeout(5000)
              }
            );
            if (freshAvRes.ok) {
              const freshAvData = await freshAvRes.json();
              const freshVersions: any[] = freshAvData?.audio_versions || (Array.isArray(freshAvData) ? freshAvData : []);
              if (freshVersions.length > 0) {
                audioVersions = freshVersions;
                const sentTrack = freshVersions.find((av: any) => av.subject_id === subjectId || av.id === subjectId);
                const langHint = detailPath.split("-").find((seg: string) =>
                  ["hindi", "english", "french", "spanish", "german", "portuguese", "russian", "arabic", "turkish", "korean", "japanese", "tamil", "telugu", "indonesian", "chinese"].includes(seg.toLowerCase())
                );
                const langTrack = langHint
                  ? freshVersions.find((av: any) => av.language?.toLowerCase() === langHint.toLowerCase() || av.detail_path?.toLowerCase().includes(langHint.toLowerCase()))
                  : null;
                const matchedTrack = sentTrack || langTrack;
                if (matchedTrack?.detail_path) {
                  logDebug(`[Dub] Fresh audio-versions found matching track: ${matchedTrack.label} → ${matchedTrack.detail_path}`);
                  const attempt2 = await tryVersionFetch(matchedTrack.subject_id || matchedTrack.id, matchedTrack.detail_path);
                  if (!attempt2) {
                    logDebug(`[Dub] ❌ Attempt 2 also failed with fresh detail_path. Dub unavailable.`);
                  }
                } else {
                  logDebug(`[Dub] No matching track found in fresh audio-versions for subjectId: ${subjectId}`);
                }
              }
            }
          } catch (freshErr: any) {
            logDebug(`[Dub] Fresh audio-versions fetch failed: ${freshErr?.message}`);
          }
        }
      }

      // 2b. Initial load ONLY (not for dub requests) — cache GET → POST scrape (Option B)
      if (!rawUrl && !isDubRequest) {
        const tvCacheParams = contentType === "tv" ? `?season=${season}&episode=${episode}` : "";
        const cacheUrl = `https://boredflix.cc/${serverNum}/scrape/get/${id}/${contentType}${tvCacheParams}${tvCacheParams ? '&' : '?'}_=${Date.now()}`;
        let cacheRes: Response | null = null;
        try {
          cacheRes = await fetchBoredflixWithFallback(cacheUrl, {
            headers: {
              "X-Bf-Client-Token": token,
              "Origin": "https://boredflix.cc",
              "Referer": "https://boredflix.cc/",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(3000)
          });
        } catch (cacheErr: any) {
          logDebug(`[Cache] GET cache failed or timed out: ${cacheErr?.message || cacheErr}`);
        }

        if (cacheRes && cacheRes.ok) {
          const cacheData = await cacheRes.json();
          if (cacheData?.results?.[server]) {
            const possibleStream = cacheData.results[server];
            const qInfo = possibleStream.quality_info || {};
            let possibleUrl: string | null = null;
            let possibleHdrs: any = null;
            if (qInfo.qualities?.length > 0) {
              const best = qInfo.qualities.find((q: any) => q.label === "1080p" || q.resolution === 1080) || qInfo.qualities[0];
              possibleUrl = best?.url || null;
              possibleHdrs = best?.playback_headers || null;
            }
            if (!possibleUrl) {
              possibleUrl = possibleStream.url || qInfo.hls_master_url || null;
              possibleHdrs = possibleStream.playback_headers || qInfo.playback_headers || null;
            }
            if (qInfo.audio_versions?.length > 0) {
              audioVersions = qInfo.audio_versions;
            } else if (possibleStream.audio_versions?.length > 0) {
              audioVersions = possibleStream.audio_versions;
            }
            if (possibleUrl) {
              const isValid = await verifyCDNUrl(possibleUrl, possibleHdrs || {});
              if (isValid) {
                activeStream = possibleStream;
              } else {
                await clearBoredflixCache(id, contentType, serverNum, token, undefined, season, episode);
              }
            }
          }
        }

        if (!activeStream) {
          const tvScrapeParams = contentType === "tv" ? { season: String(season), episode: String(episode) } : {};
          const scrapeResponse = await fetchBoredflixWithFallback("https://boredflix.cc/scrape", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Bf-Client-Token": token,
              "Origin": "https://boredflix.cc",
              "Referer": "https://boredflix.cc/",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            body: JSON.stringify({ tmdb_id: id.toString(), content_type: contentType, server, ...tvScrapeParams }),
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          });

          if (scrapeResponse.ok) {
            const resJson = await scrapeResponse.json();
            if (resJson.success && resJson.results?.[server]) {
              activeStream = resJson.results[server];
              if (audioVersions.length === 0) {
                const scrapeQInfo = activeStream.quality_info || {};
                if (scrapeQInfo.audio_versions?.length > 0) {
                  audioVersions = scrapeQInfo.audio_versions;
                } else if (activeStream.audio_versions?.length > 0) {
                  audioVersions = activeStream.audio_versions;
                }
              }
            }
          }
        }
      }

      // 3. Process active stream
      if (activeStream) {
        const qInfo = activeStream.quality_info || {};

        if (!rawUrl) {
          if (qInfo.hls_master_url) {
            rawUrl = qInfo.hls_master_url;
            playbackHeaders = activeStream.playback_headers || qInfo.playback_headers;
            details = "HLS master";
            logDebug(`[Stream] Using HLS master URL`);
          } else if (qInfo.qualities?.length > 0) {
            const best = qInfo.qualities.find((q: any) => q.label === "1080p" || q.resolution === 1080) || qInfo.qualities[0];
            if (best?.url) {
              rawUrl = best.url;
              playbackHeaders = best.playback_headers;
              details = `Stream: ${best.label || "default"}`;
              logDebug(`[Stream] Using MP4 quality: ${best.label}`);
            }
          }
          if (!rawUrl && activeStream.url) {
            rawUrl = activeStream.url;
            playbackHeaders = activeStream.playback_headers;
            details = "Primary stream";
          }
        }

        if (rawUrl && !rawUrl.toLowerCase().includes(".m3u8")) {
          const urlOk = await verifyCDNUrl(rawUrl, playbackHeaders || {});
          if (!urlOk) {
            logDebug(`[CDN Guard] Raw URL invalid/403 after scrape, forcing fresh re-scrape`);

            if (isDubRequest) {
              logDebug(`[CDN Guard] Dub request detected. Clearing dub cache and retrying version fetch...`);
              await clearBoredflixCache(id, contentType, serverNum, token, undefined, season, episode);
              await clearBoredflixCache(id, contentType, serverNum, token, subjectId, season, episode);

              const success = await tryVersionFetch(subjectId, detailPath);
              if (!success) {
                logDebug(`[CDN Guard] Dub version fetch failed after cache clear.`);
                rawUrl = null;
              }
            } else {
              await clearBoredflixCache(id, contentType, serverNum, token, undefined, season, episode);
              const tvScrapeParams2 = contentType === "tv" ? { season: String(season), episode: String(episode) } : {};
              try {
                const scrapeRes2 = await fetchBoredflixWithFallback("https://boredflix.cc/scrape", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Bf-Client-Token": token,
                    "Origin": "https://boredflix.cc",
                    "Referer": "https://boredflix.cc/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                  },
                  body: JSON.stringify({ tmdb_id: id.toString(), content_type: contentType, server, ...tvScrapeParams2 }),
                  cache: "no-store",
                  signal: AbortSignal.timeout(6000),
                });
                if (scrapeRes2.ok) {
                  const resJson2 = await scrapeRes2.json();
                  if (resJson2.success && resJson2.results?.[server]) {
                    const freshStream = resJson2.results[server];
                    const freshQInfo = freshStream.quality_info || {};
                    if (freshQInfo.hls_master_url) {
                      rawUrl = freshQInfo.hls_master_url;
                      playbackHeaders = freshStream.playback_headers || freshQInfo.playback_headers;
                      activeStream = freshStream;
                      details = "HLS master (re-scraped)";
                    } else if (freshQInfo.qualities?.length > 0) {
                      const freshBest = freshQInfo.qualities.find((q: any) => q.label === "1080p" || q.resolution === 1080) || freshQInfo.qualities[0];
                      if (freshBest?.url) {
                        rawUrl = freshBest.url;
                        playbackHeaders = freshBest.playback_headers;
                        activeStream = freshStream;
                        details = `Stream (re-scraped): ${freshBest.label}`;
                      }
                    }
                  }
                }
              } catch (reScrapeErr: any) {
                logDebug(`[CDN Guard] Re-scrape failed: ${reScrapeErr?.message}`);
              }
            }
          }
        }

        if (rawUrl) {
          const isHls = rawUrl.toLowerCase().includes(".m3u8") || rawUrl.includes("/pl/") || rawUrl.includes("/streamsvr/");
          const proxyEndpoint = isHls
            ? "https://boredflix-mp4-proxy.abdouphphtml.workers.dev/m3u8-proxy"
            : "https://boredflix-mp4-proxy.abdouphphtml.workers.dev/mp4-proxy";

          const cleanedHeaders = cleanPlaybackHeaders(playbackHeaders) || {
            "origin": "https://netfilm.world",
            "referer": "https://netfilm.world/",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
          };

          const params = new URLSearchParams();
          params.set("url", rawUrl);
          params.set("headers", JSON.stringify(cleanedHeaders));
          streamUrl = `${proxyEndpoint}?${params.toString()}`;
        }

        if (qInfo.qualities?.length > 0) {
          qualities = qInfo.qualities.map((q: any) => {
            const qIsHls = q.url.toLowerCase().includes(".m3u8") || q.url.includes("/pl/") || q.url.includes("/streamsvr/");
            const qProxyEndpoint = qIsHls
              ? "https://boredflix-mp4-proxy.abdouphphtml.workers.dev/m3u8-proxy"
              : "https://boredflix-mp4-proxy.abdouphphtml.workers.dev/mp4-proxy";

            const qCleanedHeaders = cleanPlaybackHeaders(q.playback_headers || playbackHeaders) || {
              "origin": "https://netfilm.world",
              "referer": "https://netfilm.world/",
              "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
            };

            const qParams = new URLSearchParams();
            qParams.set("url", q.url);
            qParams.set("headers", JSON.stringify(qCleanedHeaders));
            const proxiedUrl = `${qProxyEndpoint}?${qParams.toString()}`;

            return {
              label: q.label || `${q.resolution}p` || "Unknown",
              url: proxiedUrl
            };
          });
        }

        const captions = qInfo.captions || qInfo.subtitles || [];
        if (captions.length > 0) {
          subtitles = captions.map((t: any) => ({
            id: t.id,
            language: t.lanName || t.language || t.lan || "Unknown",
            label: t.lanName || t.language || t.lan || "Unknown",
            url: t.url
          }));
        }

        if (audioVersionsPromise) {
          try {
            freshDubData = await audioVersionsPromise;
            if (freshDubData?.audio_versions?.length > 0) {
              audioVersions = freshDubData.audio_versions;
            } else if (Array.isArray(freshDubData) && freshDubData.length > 0) {
              audioVersions = freshDubData;
            }
          } catch (audioErr) {
            logDebug(`[Fresh-Parallel] Dedicated audio-versions parallel resolution failed: ${audioErr}`);
          }
        }

        if (audioVersions.length === 0) {
          if (qInfo.audio_versions?.length > 0) {
            audioVersions = qInfo.audio_versions;
          } else if (activeStream?.audio_versions?.length > 0) {
            audioVersions = activeStream.audio_versions;
          }
        }

        // Prepend primary/root track if not already in the list
        const primaryTrack = extractRootAudioVersion(freshDubData || activeStream);
        if (primaryTrack) {
          const exists = audioVersions.some((av: any) => 
            (av.subject_id && av.subject_id.toString() === primaryTrack.subject_id) || 
            (av.id && av.id.toString() === primaryTrack.subject_id)
          );
          if (!exists) {
            audioVersions = [primaryTrack, ...audioVersions];
            logDebug(`[Audio] Prepended primary audio version: ${primaryTrack.label}`);
          }
        }
      }
    } catch (scrapeError: any) {
      logDebug(`[Scrape] BoredFlix scrape/cache failed: ${scrapeError?.message}`);
    }

    if (!streamUrl) {
      if (isDubRequest) {
        return NextResponse.json(
          {
            error: "This dub is currently unavailable. Please select another language.",
            dubFailed: true,
            audioVersions,
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "No stream available for this title right now. Please try again or switch to Server 2." },
        { status: 503 }
      );
    }

    const cleanTitle = mainTitle ? mainTitle.replace(/[^a-zA-Z0-9\s.-]/g, '').trim() : "Video";
    let downloadFilename = "";
    if (contentType === "tv") {
      const sStr = String(season || 1).padStart(2, '0');
      const eStr = String(episode || 1).padStart(2, '0');
      downloadFilename = `${cleanTitle} - S${sStr}E${eStr}.mp4`;
    } else {
      downloadFilename = `${cleanTitle}.mp4`;
    }

    return NextResponse.json({
      streamUrl,
      audioVersions,
      subtitles,
      qualities,
      downloadFilename,
      message: details || "OK"
    });

  } catch (error: any) {
    console.error("Video proxy error:", error);
    return NextResponse.json({ error: error.message || "Proxy request failed" }, { status: 500 });
  }
}
