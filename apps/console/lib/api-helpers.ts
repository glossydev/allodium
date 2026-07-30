import 'server-only';
import { NextResponse } from 'next/server';
import { pgErrorMessage } from './sql-utils';

/** Uniform API responses: 2xx carries data, non-2xx carries { error: string }. */

export const ok = (data: unknown, status = 200) => NextResponse.json(data, { status });

export const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Map a thrown pg/drizzle error to a 400 with the deepest useful message. */
export const oops = (e: unknown) => bad(pgErrorMessage(e));

/** Parse a JSON body, null on failure. */
export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * Parse repeatable f=col:op:val filter params (val may contain ':').
 * Mirrors the /content?f=… URL convention in ARCHITECTURE.md.
 */
export function parseFilterParams(params: URLSearchParams): { col: string; op: string; val?: string }[] {
  const out: { col: string; op: string; val?: string }[] = [];
  for (const raw of params.getAll('f')) {
    const first = raw.indexOf(':');
    if (first < 0) continue;
    const col = raw.slice(0, first);
    const rest = raw.slice(first + 1);
    const second = rest.indexOf(':');
    const op = second < 0 ? rest : rest.slice(0, second);
    if (!col || !op) continue;
    out.push(second < 0 ? { col, op } : { col, op, val: rest.slice(second + 1) });
  }
  return out;
}
