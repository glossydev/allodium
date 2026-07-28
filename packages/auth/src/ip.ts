/**
 * First-hop client IP from an `x-forwarded-for` header value (the leftmost entry is the
 * original client when your proxy chain appends). Null when the header is absent/empty —
 * callers pick their own fallback ('unknown', null, …).
 */
export function firstForwardedIp(headerValue: string | null | undefined): string | null {
  const first = headerValue?.split(',')[0]?.trim();
  return first || null;
}
