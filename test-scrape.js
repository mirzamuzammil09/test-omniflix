async function test() {
  const tokenRes = await fetch("https://boredflix.cc/api/v1/client-token", { 
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://boredflix.cc",
      "Referer": "https://boredflix.cc/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    body: JSON.stringify({})
  });
  const token = (await tokenRes.json()).token;

  console.log("Scraping 94997 without server parameter...");
  const scrapeRes = await fetch("https://boredflix.cc/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bf-Client-Token": token,
      "Origin": "https://boredflix.cc",
      "Referer": "https://boredflix.cc/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    body: JSON.stringify({ tmdb_id: "94997", content_type: "tv", season: "1", episode: "1", server: "source_06" })
  });
  console.log(await scrapeRes.text());
}
test().catch(console.error);
