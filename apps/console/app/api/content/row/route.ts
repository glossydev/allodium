import type { NextRequest } from 'next/server';
import { insertRow, updateRow, deleteRow } from '@/lib/dml';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * Row write surface. RAW table writes — no app logic fires; that's the console's
 * contract (identical semantics to editing in a DB GUI). lib/dml enforces
 * catalog-verified names, ::cast bound params, and masked-column rejection.
 */

export async function POST(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const res = await insertRow(String(body.table ?? ''), body.values);
    if (!res.ok) return bad(res.error);
    console.log(`[console] INSERT ${String(body.table)}`);
    return ok({ row: res.row }, 201);
  } catch (e) {
    return oops(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const res = await updateRow(String(body.table ?? ''), body.id, body.values);
    if (!res.ok) return bad(res.error);
    console.log(`[console] UPDATE ${String(body.table)} ${String(body.id)}`);
    return ok({ row: res.row });
  } catch (e) {
    return oops(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const res = await deleteRow(String(body.table ?? ''), body.id);
    if (!res.ok) return bad(res.error);
    console.log(`[console] DELETE ${String(body.table)} ${String(body.id)}`);
    return ok({ ok: true });
  } catch (e) {
    return oops(e);
  }
}
