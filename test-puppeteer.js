const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/scrape') || url.includes('/api/')) {
      try {
        const text = await response.text();
        console.log(`[Response] ${url} -> ${text.substring(0, 300)}...`);
      } catch (e) {}
    }
  });

  page.on('request', request => {
    const url = request.url();
    if (url.includes('/scrape') || url.includes('/api/')) {
      console.log(`[Request] ${request.method()} ${url} | PostData: ${request.postData()}`);
    }
  });

  console.log("Navigating to https://boredflix.cc/tv/949971/1 ...");
  await page.goto('https://boredflix.cc/tv/949971/1', { waitUntil: 'networkidle2' });
  
  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
})();
