import { NextRequest, NextResponse } from "next/server";
import { tmdb } from "@/services/tmdb";
import { shouldAttemptExternalProxy } from "@/lib/playback-proxy";
import https from "https";
import http from "http";
import tls from "tls";

export const maxDuration = 60;


const logDebug = (msg: string) => {
  console.log(`[Playback-Debug] ${msg}`);
};

const isServerless =
  process.env.VERCEL === "1" ||
  process.env.NETLIFY === "true" ||
  process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

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
  if (!url) return true;
  try {
    const parsedUrl = new URL(url);
    const tParam = parsedUrl.searchParams.get("t");
    if (tParam) {
      const timestamp = parseInt(tParam, 10);
      const now = Math.floor(Date.now() / 1000);
      // If the URL is more than 1 hour (3600s) old, consider it expired
      if (now - timestamp > 3600) {
        return true;
      }
    }
  } catch (e) {
    // Ignore invalid URLs
  }
  return false;
};

const cleanPlaybackHeaders = (headers: any): any => {
  const defaultHeaders = {
    "origin": "https://netfilm.world",
    "referer": "https://netfilm.world/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
  };

  if (!headers || typeof headers !== "object") {
    return defaultHeaders;
  }

  const cleaned = { ...defaultHeaders, ...headers };
  if (!cleaned.referer || cleaned.referer === "https://netfilm.world") {
    cleaned.referer = "https://netfilm.world/";
  }
  if (!cleaned.origin) {
    cleaned.origin = "https://netfilm.world";
  }
  if (!cleaned["user-agent"]) {
    cleaned["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
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
let workingProxies: string[] = [];

// Track when direct fetch to boredflix.cc is blocked (e.g. CF-blocked on local dev IP).
// After first confirmed failure, skip the 4.5s direct-fetch wasted round-trip for this process lifetime.
let directFetchBlocked = false;
let directFetchBlockedUntil = 0;

// Fallback hardcoded proxies to use if both proxyscrape and monosans fail or time out.
const fallbackProxiesList: string[] = [
  "95.211.174.135:3128",
  "2.59.43.253:22222",
  "135.87.39.23:80",
  "85.237.39.139:8080",
  "160.238.65.7:3128",
  "176.111.37.216:39811",
  "93.77.191.156:8118",
  "135.87.39.23:9443",
  "168.184.84.85:443",
  "153.80.240.37:8080",
  "176.88.166.163:8080",
  "103.167.61.162:3128",
  "91.84.104.61:8118",
  "34.69.61.247:80",
  "80.90.186.133:8444",
  "135.87.39.23:443",
  "149.18.81.114:7890",
  "176.111.37.5:39811",
  "45.153.4.154:3128",
  "34.186.244.31:443",
  "188.127.224.164:2080",
  "185.191.239.248:3128",
  "94.158.49.82:3128",
  "49.48.142.46:8080",
  "160.238.65.4:3128",
  "34.43.46.91:80",
  "93.185.68.82:8080",
  "154.17.8.103:1680",
  "160.250.130.72:3128",
  "43.153.82.179:8888",
  "20.83.140.251:8080",
  "42.96.18.62:1311",
  "157.254.194.57:1080",
  "64.112.184.210:3128",
  "3.211.120.181:443",
  "182.253.228.155:80",
  "175.139.255.25:8181",
  "110.172.29.162:443",
  "213.226.127.45:8000",
  "34.94.46.8:80",
  "1.231.81.166:3128",
  "168.184.84.54:80"
];

async function getFreeProxies(): Promise<string[]> {
  const now = Date.now();
  // Cache proxy list for 30 minutes
  if (cachedProxiesList.length > 0 && now - cachedProxiesTime < 30 * 60 * 1000) {
    return cachedProxiesList;
  }

  logDebug(`[Proxy] Fetching proxy lists in parallel...`);

  const fetchProxyscrape = async () => {
    try {
      const res = await fetch("https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=all", {
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) throw new Error("Proxyscrape error " + res.status);
      const text = await res.text();
      const list = text.split("\n").map(p => p.trim()).filter(Boolean);
      if (list.length === 0) throw new Error("Proxyscrape empty");
      return list;
    } catch (e: any) {
      logDebug(`[Proxy] Proxyscrape fetch failed: ${e.message}`);
      throw e;
    }
  };

  const fetchMonosans = async () => {
    try {
      const res = await fetch("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", {
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) throw new Error("Monosans error " + res.status);
      const text = await res.text();
      const list = text.split("\n").map(p => p.trim()).filter(Boolean);
      if (list.length === 0) throw new Error("Monosans empty");
      return list;
    } catch (e: any) {
      logDebug(`[Proxy] Monosans fetch failed: ${e.message}`);
      throw e;
    }
  };

  const fetchTheSpeedX = async () => {
    try {
      const res = await fetch("https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", {
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) throw new Error("TheSpeedX error " + res.status);
      const text = await res.text();
      const list = text.split("\n").map(p => p.trim()).filter(Boolean);
      if (list.length === 0) throw new Error("TheSpeedX empty");
      return list;
    } catch (e: any) {
      logDebug(`[Proxy] TheSpeedX fetch failed: ${e.message}`);
      throw e;
    }
  };

  const fetchPrxchk = async () => {
    try {
      const res = await fetch("https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt", {
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) throw new Error("Prxchk error " + res.status);
      const text = await res.text();
      const list = text.split("\n").map(p => p.trim()).filter(Boolean);
      if (list.length === 0) throw new Error("Prxchk empty");
      return list;
    } catch (e: any) {
      logDebug(`[Proxy] Prxchk fetch failed: ${e.message}`);
      throw e;
    }
  };

  const results = await Promise.allSettled([fetchProxyscrape(), fetchMonosans(), fetchTheSpeedX(), fetchPrxchk()]);
  const combinedList: string[] = [];
  results.forEach(r => {
    if (r.status === "fulfilled" && r.value.length > 0) {
      combinedList.push(...r.value);
    }
  });

  if (combinedList.length > 0) {
    const uniqueList = Array.from(new Set(combinedList));
    cachedProxiesList = uniqueList;
    cachedProxiesTime = now;
    logDebug(`[Proxy] Successfully cached ${uniqueList.length} unique proxies from parallel fetch`);
    return uniqueList;
  }

  logDebug(`[Proxy] All parallel proxy fetches failed. Using fallback list.`);
  if (cachedProxiesList.length > 0) {
    return cachedProxiesList;
  }

  // DO NOT cache the fallback list for 30 minutes, because if fetching failed due to a temporary
  // timeout, we don't want to be stuck with dead hardcoded proxies for half an hour!
  logDebug(`[Proxy] Cached fallback list (${fallbackProxiesList.length} proxies) but NOT setting cache time to allow retry on next request.`);
  return fallbackProxiesList;
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
      const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : (proxyUrl.protocol === "https:" ? 443 : 80);

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
              } catch (e) { }

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
              } catch (e) { }

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
  const externalProxyUrl = process.env.EXTERNAL_PROXY_URL;
  const shouldUseExternalProxyFallback = shouldAttemptExternalProxy(url, {
    isServerless,
    externalProxyUrl,
  });

  // 1. Direct Fetch first, even in serverless environments.
  // This avoids the worker-specific 403/Origin restrictions on boredflix endpoints
  // while still allowing an external proxy fallback when the direct request fails.
  const now = Date.now();
  const isDirectBlocked = directFetchBlocked && now < directFetchBlockedUntil;
  if (!isDirectBlocked) {
    const directTimeout = 10000; // 10s budget for POST /scrape to contact upstream provider
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), directTimeout);

      const onAbort = () => {
        controller.abort();
      };
      if (options.signal) {
        if (options.signal.aborted) {
          throw new Error("Aborted");
        }
        options.signal.addEventListener('abort', onAbort);
      }

      const directOptions = { ...options, signal: controller.signal };

      logDebug(`[Proxy-Client] Attempting direct fetch to ${url} (Timeout: ${directTimeout}ms)...`);
      const res = await fetch(url, directOptions);
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }

      if (res.ok) {
        // Direct fetch worked — site is reachable, clear blocked flag
        directFetchBlocked = false;
        logDebug(`[Proxy-Client] Direct fetch succeeded for ${url}`);
        return res;
      }

      if (res.status === 403) {
        directFetchBlocked = true;
        directFetchBlockedUntil = Date.now() + 10 * 1000; // 10 seconds (allow fast recovery)
        logDebug(`[Proxy-Client] Direct fetch blocked (403) for ${url}. Marking blocked for 10s.`);
      } else {
        logDebug(`[Proxy-Client] Direct fetch returned status ${res.status} for ${url}.`);
      }
    } catch (err: any) {
      // Timeout or network error — mark as blocked briefly (5s) so we don't stall
      directFetchBlocked = true;
      directFetchBlockedUntil = Date.now() + 5 * 1000; // 5 seconds
      logDebug(`[Proxy-Client] Direct fetch failed/timed out for ${url}: ${err.message}. Marking blocked for 5s.`);
    }
  } else {
    logDebug(`[Proxy-Client] Direct fetch skipped (known blocked, ${Math.ceil((directFetchBlockedUntil - now) / 1000)}s remaining).`);
  }

  // 2. External proxy fallback for non-boredflix requests when direct fetch fails.
  if (shouldUseExternalProxyFallback && externalProxyUrl) {
    try {
      const proxyUrl = new URL(externalProxyUrl);
      proxyUrl.searchParams.set('url', url);
      const proxyOptions: any = {
        method: options.method || 'GET',
        headers: options.headers || undefined,
        body: options.body || undefined,
        signal: options.signal || undefined,
        cache: options.cache || undefined,
      };
      logDebug(`[Proxy-Client] Falling back to EXTERNAL_PROXY_URL for ${url}: ${proxyUrl.toString()}`);
      const res = await fetch(proxyUrl.toString(), proxyOptions);
      return res;
    } catch (e: any) {
      logDebug(`[Proxy-Client] EXTERNAL_PROXY_URL delegation failed: ${e?.message || e}`);
    }
  }

  // 3. Proxy Rotation
  const proxies = await getFreeProxies();
  if (proxies.length === 0) {
    logDebug(`[Proxy-Client] No backup proxies available, throwing error`);
    throw new Error("No proxies available");
  }

  const shuffled = [...proxies].sort(() => 0.5 - Math.random());
  // Test proxies in parallel (max 30)
  const maxParallel = 30;
  const testProxies = shuffled.slice(0, maxParallel);

  // Prepend recent working proxies to test in parallel at the front of the list.
  workingProxies.forEach(proxy => {
    if (!testProxies.includes(proxy)) {
      testProxies.unshift(proxy);
    }
  });

  logDebug(`[Proxy-Client] Testing ${testProxies.length} proxies in parallel for URL: ${url}`);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let completedCount = 0;
    const errors: any[] = [];
    const abortControllers: AbortController[] = [];

    // Link options.signal to abort all proxy abortControllers
    const parentAbortHandler = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(overallTimeout);
        abortControllers.forEach(ctrl => ctrl.abort());
        reject(new Error("Request aborted by client/timeout"));
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        reject(new Error("Request aborted by client/timeout"));
        return;
      }
      options.signal.addEventListener('abort', parentAbortHandler);
    }

    const cleanup = () => {
      clearTimeout(overallTimeout);
      if (options.signal) {
        options.signal.removeEventListener('abort', parentAbortHandler);
      }
    };

    // Safety timeout to ensure we return before execution limit (Netlify 10s limit without maxDuration)
    // Since we added maxDuration = 60, we can safely allow up to 8s for proxy rotation on serverless.
    const timeoutDuration = isServerless ? 8000 : 12000;
    const overallTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
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
            cleanup();
            abortControllers.forEach(ctrl => ctrl.abort());
            logDebug(`[Proxy-Client] Parallel Proxy http://${proxy} succeeded!`);

            // Cache the successful proxy in memory for subsequent requests
            if (!workingProxies.includes(proxy)) {
              workingProxies.unshift(proxy);
              if (workingProxies.length > 5) {
                workingProxies.pop();
              }
            }

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
            cleanup();
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
const playbackCache = new Map<string, { data: any; expiresAt: number }>();
const PLAYBACK_CACHE_TTL_MS = 2 * 60 * 1000;

const buildPlaybackCacheKey = (body: any): string => {
  const { id, subjectId, detailPath, server = "source_06", type = "movie", season, episode } = body || {};
  return JSON.stringify({
    id: id?.toString() || "",
    subjectId: subjectId?.toString() || "",
    detailPath: detailPath || "",
    server: String(server),
    type: String(type),
    season: season?.toString() || "",
    episode: episode?.toString() || "",
  });
};

export async function POST(request: NextRequest) {
  // Hotlinking & Scraper Guard: Only allow requests originating from our own domain
  const referer = request.headers.get("referer");
  const origin = request.headers.get("origin");
  const hostHeader = request.headers.get("host") || "";
  const xForwardedHost = request.headers.get("x-forwarded-host") || "";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const baseUrl = `${proto}://${hostHeader || "localhost:3000"}`;

  const host = (xForwardedHost.split(",")[0] || hostHeader || "").split(":")[0].trim();
  const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1") || !host;

  if (!isLocalhost) {
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        logDebug(`[Guard] Permitted referer: ${refererUrl.hostname} for host ${host} (Iframe embed allowed)`);
      } catch (e) {
        logDebug(`[Guard] Permitted referer (invalid format): ${referer} for host ${host}`);
      }
    } else {
      logDebug(`[Guard] Request missing referer header for host ${host}`);
    }

    if (origin) {
      try {
        const originUrl = new URL(origin);
        logDebug(`[Guard] Permitted origin: ${originUrl.hostname} for host ${host} (Iframe embed allowed)`);
      } catch (e) {
        logDebug(`[Guard] Permitted origin (invalid format): ${origin} for host ${host}`);
      }
    } else {
      logDebug(`[Guard] Request missing origin header for host ${host}`);
    }
  }

  const requestStart = Date.now();
  const MAX_REQUEST_TIME = 45000; // 45s budget with maxDuration 60s

  const getRemainingTimeout = (extraBuffer = 1000): number => {
    const elapsed = Date.now() - requestStart;
    return Math.max(4000, MAX_REQUEST_TIME - elapsed - extraBuffer);
  };

  try {
    const body = await request.json();
    const { id, subjectId, detailPath, server = "source_06", type = "movie", season, episode, forceRefresh } = body;

    logDebug(`POST request received. ID: ${id}, type: ${type}, server: ${server}, season: ${season}, episode: ${episode}, subjectId: ${subjectId}, detailPath: ${detailPath}, forceRefresh: ${forceRefresh}`);

    const cacheKey = buildPlaybackCacheKey(body);
    const cachedPlayback = !forceRefresh ? playbackCache.get(cacheKey) : null;
    if (cachedPlayback && cachedPlayback.expiresAt > Date.now()) {
      logDebug(`[Cache] Returning cached playback response for ${cacheKey}`);
      const cachedResponse = NextResponse.json(cachedPlayback.data);
      cachedResponse.headers.set("Cache-Control", "public, max-age=60, s-maxage=120, stale-while-revalidate=60");
      return cachedResponse;
    }

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
    let isNetworkProblem = false;
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
          // Fixed independent signal — NOT budget-derived.
          // Worst-case: direct(4.5s) + proxy-list(1.5s) + proxy-rotation(9s) = 15s.
          // After directFetchBlocked is set, becomes ~10.5s in practice.
          signal: AbortSignal.timeout(15000),
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
      let audioVersionsStartTime = 0;
      if (!isDubRequest) {
        const tvAudioParams = contentType === "tv" ? `&season=${season}&episode=${episode}` : "";
        const audioVersionsUrl = `https://boredflix.cc/${serverNum}/aoneroom/audio-versions?tmdb_id=${id}&type=${contentType}${tvAudioParams}&_=${Date.now()}`;
        logDebug(`[Parallel Audio] Starting parallel fetch for: ${audioVersionsUrl}`);
        // 12s signal: after directFetchBlocked is set, proxy-rotation gets the full
        // 9s overallTimeout window. Without directFetchBlocked the 4.5s direct fetch
        // + 1.5s proxy-list eats 6s, leaving only 6s for rotation — so 12s is the minimum.
        audioVersionsStartTime = Date.now();
        audioVersionsPromise = fetchBoredflixWithFallback(audioVersionsUrl, {
          headers: {
            "X-Bf-Client-Token": token,
            "Origin": "https://boredflix.cc",
            "Referer": "https://boredflix.cc/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(12000)
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
      const tryVersionFetch = async (sid: string, dpath: string, forceFresh = false): Promise<boolean> => {
        const forceParam = forceFresh ? "&force_refresh=true" : "";
        const versionUrl = `https://boredflix.cc/${serverNum}/aoneroom/version?tmdb_id=${id}&subject_id=${sid}&detail_path=${dpath}&type=${contentType}${tvParams}${forceParam}&_=${Date.now()}`;
        logDebug(`[Dub] Fetching version (forceFresh=${forceFresh}): ${versionUrl}`);
        try {
          const versionRes = await fetchBoredflixWithFallback(versionUrl, {
            headers: {
              "X-Bf-Client-Token": token,
              "Origin": "https://boredflix.cc",
              "Referer": "https://boredflix.cc/",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(isServerless ? 4500 : Math.min(5000, getRemainingTimeout(1000)))
          });
          if (versionRes.ok) {
            const versionData = await versionRes.json();
            const dubUrl = versionData?.url || versionData?.m3u8_url || versionData?.quality_info?.hls_master_url;
            if (dubUrl) {
              if (isExpired(dubUrl)) {
                logDebug(`[Dub] ⚠️ Version URL for ${dpath} is expired (t timestamp too old). Clearing cache & retrying fresh...`);
                await clearBoredflixCache(id, contentType, serverNum, token, sid, season, episode);
                if (!forceFresh) {
                  return await tryVersionFetch(sid, dpath, true);
                }
                return false;
              }
              activeStream = versionData;
              rawUrl = dubUrl;
              playbackHeaders = versionData.quality_info?.playback_headers;
              details = `Dub stream: ${dpath}`;
              logDebug(`[Dub] ✅ Got valid dub stream URL for ${dpath}`);
              return true;
            }
            logDebug(`[Dub] Version OK but no URL in response for ${dpath}`);
          } else {
            logDebug(`[Dub] Version HTTP ${versionRes.status} for ${dpath}`);
            if (versionRes.status === 401 || versionRes.status === 403) {
              logDebug(`[Token] Version fetch returned status ${versionRes.status}. Clearing cached token.`);
              cachedToken = null;
              cachedTokenTime = 0;
            }
          }
        } catch (e: any) {
          logDebug(`[Dub] Version fetch error: ${e?.message}`);
        }
        return false;
      };

      // 2a. Dub version fetch (Option A) — with fresh-path retry on 502
      if (subjectId && detailPath) {
        const attempt1 = await tryVersionFetch(subjectId, detailPath, forceRefresh);

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
                signal: AbortSignal.timeout(Math.min(4000, getRemainingTimeout(1000)))
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
                  const attempt2 = await tryVersionFetch(matchedTrack.subject_id || matchedTrack.id, matchedTrack.detail_path, true);
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
            // 4.5s direct + 1.5s proxy-list + 9s proxy-rotation = 15s worst-case.
            // After first failure, directFetchBlocked cuts direct to 0s, making ~10.5s sufficient.
            signal: AbortSignal.timeout(15000)
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
            body: JSON.stringify({ tmdb_id: id.toString(), content_type: contentType, server, force_refresh: forceRefresh, ...tvScrapeParams }),
            cache: "no-store",
            // 4.5s direct + 1.5s proxy-list + 9s proxy-rotation = 15s worst-case.
            // After first failure, directFetchBlocked shortens this to ~10.5s.
            signal: AbortSignal.timeout(15000)
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
          } else if (scrapeResponse.status === 401 || scrapeResponse.status === 403) {
            logDebug(`[Token] Scraping returned status ${scrapeResponse.status}. Clearing cached token.`);
            cachedToken = null;
            cachedTokenTime = 0;
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
              logDebug(`[CDN Guard] Dub request detected. Clearing dub cache and retrying version fetch with force_refresh...`);
              await clearBoredflixCache(id, contentType, serverNum, token, undefined, season, episode);
              await clearBoredflixCache(id, contentType, serverNum, token, subjectId, season, episode);

              const success = await tryVersionFetch(subjectId, detailPath, true);
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
                  body: JSON.stringify({ tmdb_id: id.toString(), content_type: contentType, server, force_refresh: true, ...tvScrapeParams2 }),
                  cache: "no-store",
                  signal: AbortSignal.timeout(15000) // Independent fixed timeout
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
          const proxyEndpoint = "/api/proxy";

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
            const qProxyEndpoint = "/api/proxy";

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
            // Deadline-based race: cap at 13s from when audio-versions started.
            // Must exceed the 12s AbortSignal on the fetch so the signal fires first
            // (not the deadline), giving audio-versions the best chance to succeed.
            const elapsed = Date.now() - audioVersionsStartTime;
            const remainingForAudio = Math.max(0, 13000 - elapsed);
            const audioTimeoutPromise = new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), remainingForAudio)
            );
            freshDubData = await Promise.race([audioVersionsPromise, audioTimeoutPromise]);
            if (freshDubData?.audio_versions?.length > 0) {
              audioVersions = freshDubData.audio_versions;
            } else if (Array.isArray(freshDubData) && freshDubData.length > 0) {
              audioVersions = freshDubData;
            }
            if (!freshDubData) {
              logDebug(`[Fresh-Parallel] audio-versions timed out at await-point (${elapsed}ms elapsed, ${remainingForAudio}ms budget given)`);
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
      const msg = scrapeError?.message || "";
      if (msg.includes("ENOTFOUND") || msg.includes("ENETUNREACH") || msg.includes("EHOSTUNREACH") || msg.includes("fetch failed") || msg.includes("timed out")) {
        isNetworkProblem = true;
      }
    }

    if (!streamUrl) {
      let finalErrorMsg = "No stream available for this title right now. Please try again or switch to Server 2.";
      if (isNetworkProblem) {
         finalErrorMsg = "Your internet connection seems slow or disconnected. Please check your network and try again.";
      } else if (isDubRequest) {
         finalErrorMsg = "This dub is currently unavailable. Please select another language.";
      }

      if (isDubRequest) {
        return NextResponse.json(
          {
            error: finalErrorMsg,
            dubFailed: true,
            audioVersions,
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: finalErrorMsg },
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

    const payload = {
      streamUrl,
      audioVersions,
      subtitles,
      qualities,
      downloadFilename,
      message: details || "OK"
    };

    playbackCache.set(cacheKey, {
      data: payload,
      expiresAt: Date.now() + PLAYBACK_CACHE_TTL_MS,
    });

    const response = NextResponse.json(payload);
    response.headers.set("Cache-Control", "public, max-age=60, s-maxage=120, stale-while-revalidate=60");
    return response;

  } catch (error: any) {
    console.error("Video proxy error:", error);
    return NextResponse.json({ error: error.message || "Proxy request failed" }, { status: 500 });
  }
}
