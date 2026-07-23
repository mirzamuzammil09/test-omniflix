async function testM3u8Proxy() {
  console.log("=== STEP 1: Fetch fresh stream from BoredFlix for 86031 S1E1 ===");
  const tokenRes = await fetch("https://boredflix.cc/api/v1/client-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://boredflix.cc",
      "Referer": "https://boredflix.cc/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    },
    body: JSON.stringify({})
  });
  const { token } = await tokenRes.json();

  const scrapeRes = await fetch("https://boredflix.cc/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bf-Client-Token": token,
      "Origin": "https://boredflix.cc",
      "Referer": "https://boredflix.cc/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    body: JSON.stringify({ tmdb_id: "86031", content_type: "tv", season: "1", episode: "1", server: "source_06" })
  });
  const scrapeData = await scrapeRes.json();
  const s06 = scrapeData.results?.source_06;
  console.log("Source 06 stream object:", JSON.stringify(s06, null, 2));

  const rawUrl = s06?.url;
  const pbHeaders = s06?.quality_info?.playback_headers || {
    origin: "https://netfilm.world",
    referer: "https://netfilm.world/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
  };

  if (!rawUrl) return;

  console.log("\n=== STEP 2: Testing BoredFlix Worker /m3u8-proxy Endpoint ===");
  const workerBase = "https://boredflix-mp4-proxy-v2.abdouphphtml.workers.dev/m3u8-proxy";
  const proxyUrl = `${workerBase}?url=${encodeURIComponent(rawUrl)}&headers=${encodeURIComponent(JSON.stringify(pbHeaders))}`;

  console.log("Worker Proxy URL:", proxyUrl.slice(0, 120) + "...");
  const res = await fetch(proxyUrl, {
    headers: {
      "Range": "bytes=0-100",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });

  console.log("Status:", res.status);
  console.log("Content-Type:", res.headers.get("content-type"));
  console.log("Content-Range:", res.headers.get("content-range"));
}

testM3u8Proxy().catch(console.error);
