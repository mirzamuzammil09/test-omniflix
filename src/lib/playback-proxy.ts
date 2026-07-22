export function isBoredflixApiEndpoint(url: string): boolean {
  const normalizedUrl = url.toLowerCase();

  if (!normalizedUrl.includes("boredflix.cc")) {
    return false;
  }

  return (
    normalizedUrl.includes("/api/v1/client-token") ||
    normalizedUrl.includes("/aoneroom/audio-versions") ||
    normalizedUrl.includes("/aoneroom/version") ||
    normalizedUrl.includes("/scrape/get") ||
    normalizedUrl.includes("/scrape")
  );
}

export function shouldAttemptExternalProxy(
  url: string,
  options: { isServerless?: boolean; externalProxyUrl?: string | null } = {}
): boolean {
  if (!options.isServerless || !options.externalProxyUrl) {
    return false;
  }

  return !isBoredflixApiEndpoint(url);
}
