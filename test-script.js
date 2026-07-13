async function test() {
  try {
    const tokenRes = await fetch("https://boredflix.cc/api/v1/client-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://boredflix.cc",
        "Referer": "https://boredflix.cc/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: JSON.stringify({})
    });
    
    if (!tokenRes.ok) {
      console.error("Token status:", tokenRes.status);
      return;
    }
    
    const { token } = await tokenRes.json();
    console.log("Token:", token);
    
    const avRes = await fetch("https://boredflix.cc/6/aoneroom/audio-versions?tmdb_id=634649&type=movie", {
      headers: {
        "X-Bf-Client-Token": token,
        "Origin": "https://boredflix.cc",
        "Referer": "https://boredflix.cc/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    
    const data = await avRes.json();
    console.log("Audio versions status:", avRes.status);
    console.log("Audio versions data:", JSON.stringify(data));
  } catch (err) {
    console.error("Error:", err);
  }
}
test();
