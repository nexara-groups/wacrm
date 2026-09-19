/** True when Fetch Metadata or Origin identifies a cross-site browser mutation. */
export function isCrossSiteRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    return true;
  }

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}
