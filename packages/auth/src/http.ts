/**
 * The little HTTP plumbing the route factories share: an origin allowlist,
 * CORS headers for a request, a JSON response that carries cookies, and a
 * redirect that does the same. Kept here so the optional entry points
 * (./reset, ./oidc) do not each grow their own copy.
 */

export type AllowOrigins = string[] | ((origin: string) => boolean) | undefined;

export const originAllowedBy =
  (allow: AllowOrigins) =>
  (origin: string): boolean =>
    !!allow && (typeof allow === 'function' ? allow(origin) : allow.includes(origin));

/** CORS headers for a request, or nothing when it is same-origin or not allowed. Exact origin, never "*". */
export function corsHeaders(request: Request, allow: AllowOrigins): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || !originAllowedBy(allow)(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
}

export interface CookieJar {
  applyTo(headers: Headers): void;
}

export function jsonResponse(request: Request, allow: AllowOrigins, body: unknown, status = 200, jar?: CookieJar): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', ...corsHeaders(request, allow) });
  jar?.applyTo(headers);
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirectResponse(location: string, jar?: CookieJar): Response {
  const headers = new Headers({ Location: location });
  jar?.applyTo(headers);
  return new Response(null, { status: 302, headers });
}

export function preflightResponse(request: Request, allow: AllowOrigins, methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(request, allow), 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
  });
}

/** The first client IP, from the proxy header or nothing. */
export function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? null;
}
