import test from 'node:test';
import assert from 'node:assert/strict';
import { isBoredflixApiEndpoint, shouldAttemptExternalProxy } from '../src/lib/playback-proxy.js';

test('boredflix token and scrape URLs should not be forced through the external proxy', () => {
  const tokenUrl = 'https://boredflix.cc/api/v1/client-token';
  const scrapeUrl = 'https://boredflix.cc/scrape';

  assert.equal(isBoredflixApiEndpoint(tokenUrl), true);
  assert.equal(isBoredflixApiEndpoint(scrapeUrl), true);
  assert.equal(
    shouldAttemptExternalProxy(tokenUrl, {
      isServerless: true,
      externalProxyUrl: 'https://example-proxy.test',
    }),
    false
  );
});

test('non-boredflix URLs can still use the external proxy fallback', () => {
  assert.equal(
    shouldAttemptExternalProxy('https://cdn.example.com/stream.mp4', {
      isServerless: true,
      externalProxyUrl: 'https://example-proxy.test',
    }),
    true
  );
});
