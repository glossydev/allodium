import { NextResponse, type NextRequest } from 'next/server';

/**
 * Local-only guard for the whole console.
 *
 * The console has no auth in v1, so "it's a localhost dev tool" IS the security
 * model — and that model needs enforcing rather than assuming. Two holes existed:
 *
 *  1. LAN exposure. `next dev` binds the wildcard address by default, so the console
 *     (and /api/sql, which can read every table) answered on the machine's LAN IP.
 *     The dev/start scripts now pass -H 127.0.0.1; this is the second line.
 *  2. CSRF / DNS rebinding. Loopback binding does NOT stop a page the developer
 *     visits from POSTing here — a `text/plain` body is a CORS "simple" request that
 *     needs no preflight, so any site could have driven `drop table` through
 *     /api/schema/ddl. And a hostname resolving to 127.0.0.1 makes responses readable.
 *
 * So: pin Host to loopback, require same-origin (or absent, for curl) on mutations,
 * and refuse cross-site fetches outright.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostname(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  // Strip the port, keeping bracketed IPv6 intact.
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim());
  return m ? m[1].toLowerCase() : null;
}

export function middleware(request: NextRequest) {
  const host = hostname(request.headers.get('host'));
  if (!host || !LOOPBACK_HOSTS.has(host)) {
    // Anything addressing us by a non-loopback name is either LAN traffic or a
    // rebinding attempt. Refuse before any handler or page runs.
    return new NextResponse('The Allodium console only serves loopback (http://localhost:3180).', {
      status: 421,
      headers: { 'content-type': 'text/plain' },
    });
  }

  // Sec-Fetch-Site is set by every modern browser and cannot be forged by page JS.
  // 'none' = typed in the address bar, 'same-origin' = our own fetches.
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'Cross-site requests are refused' }, { status: 403 });
  }

  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    // Mutations must be same-origin. A missing Origin means a non-browser client
    // (curl, scripts) which cannot be a drive-by; a mismatched one is an attack.
    const origin = request.headers.get('origin');
    if (origin) {
      const originHost = (() => {
        try {
          return new URL(origin).hostname.toLowerCase();
        } catch {
          return null;
        }
      })();
      if (!originHost || !LOOPBACK_HOSTS.has(originHost)) {
        return NextResponse.json({ error: 'Cross-origin write refused' }, { status: 403 });
      }
    }

    // Block CORS-"simple" content types so a form/text POST can never reach a
    // handler without a preflight the browser will refuse.
    const ct = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const isUpload = request.nextUrl.pathname === '/api/files/upload';
    const allowed = isUpload ? ['multipart/form-data'] : ['application/json'];
    if (ct && !allowed.includes(ct)) {
      return NextResponse.json(
        { error: `Unsupported content-type: ${ct} (expected ${allowed.join(' or ')})` },
        { status: 415 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
