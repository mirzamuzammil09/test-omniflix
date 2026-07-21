const { URL } = require('url');
const urlStr = "http://103.49.202.252:80";
const proxyUrl = new URL(urlStr);
const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : (proxyUrl.protocol === "https:" ? 443 : 80);
console.log(proxyPort);
