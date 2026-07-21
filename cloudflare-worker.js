addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  const url = new URL(request.url);
  const targetUrlStr = url.searchParams.get("url");
  const headersStr = url.searchParams.get("headers");

  if (!targetUrlStr) {
    return new Response("Missing 'url' parameter", { status: 400 });
  }

  let targetHeaders = {};
  try {
    if (headersStr) {
      targetHeaders = JSON.parse(headersStr);
    }
  } catch (e) {
    return new Response("Invalid headers JSON", { status: 400 });
  }

  const modifiedRequest = new Request(targetUrlStr, {
    method: request.method,
    headers: targetHeaders
  });

  try {
    let response = await fetch(modifiedRequest);
    let body = response.body;

    const pathname = url.pathname;
    
    // Rewrite m3u8 playlists if requested through m3u8 proxy
    if (pathname.includes("m3u8") && response.status === 200) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("mpegurl") || contentType.includes("application/vnd.apple.mpegurl") || targetUrlStr.includes(".m3u8")) {
        const text = await response.text();
        const rewritten = rewriteM3u8(text, targetUrlStr, url.origin, pathname, headersStr);
        body = rewritten;
      }
    }

    response = new Response(body, response);
    // Overwrite CORS headers so the browser allows the stream
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "*");
    response.headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
    
    return response;
  } catch (e) {
    return new Response(e.message, { status: 500 });
  }
}

function handleOptions(request) {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    }
  });
}

function rewriteM3u8(playlist, baseUrl, proxyOrigin, proxyPath, headersStr) {
  const lines = playlist.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#')) {
      let segmentUrl;
      if (line.startsWith('http://') || line.startsWith('https://')) {
        segmentUrl = line;
      } else {
        segmentUrl = new URL(line, baseUrl).href;
      }
      
      const params = new URLSearchParams();
      params.set('url', segmentUrl);
      if (headersStr) {
        params.set('headers', headersStr);
      }
      lines[i] = `${proxyOrigin}${proxyPath}?${params.toString()}`;
    }
  }
  return lines.join('\n');
}
