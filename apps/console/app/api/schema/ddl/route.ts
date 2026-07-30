import type { NextRequest } from 'next/server';
import { ok, bad, oops, jsonBody } from '@/lib/api-helpers';
import {
  buildCreateTable,
  buildAddColumn,
  buildDropColumn,
  buildDropTable,
  buildRenameTable,
  buildAddForeignKey,
  buildDropConstraint,
  buildCreateJoinTable,
  executeDdl,
  type ColumnSpec,
} from '@/lib/ddl';

export const dynamic = 'force-dynamic';

/**
 * POST /api/schema/ddl { action, params, execute }
 *
 * Two-step by design: execute=false returns the generated SQL for preview;
 * execute=true runs it. The UI always previews first — the user sees exactly
 * what will run, and failures return the verbatim pg error.
 */

type Built = { ok: true; sql: string } | { ok: false; error: string };

async function build(action: string, p: Record<string, unknown>): Promise<Built> {
  switch (action) {
    case 'createTable':
      return buildCreateTable({ name: String(p.name ?? ''), columns: (p.columns ?? []) as ColumnSpec[] });
    case 'addColumn':
      return buildAddColumn(String(p.table ?? ''), p.column as ColumnSpec);
    case 'dropColumn':
      return buildDropColumn(String(p.table ?? ''), String(p.column ?? ''));
    case 'dropTable':
      return buildDropTable(String(p.table ?? ''));
    case 'renameTable':
      return buildRenameTable(String(p.table ?? ''), String(p.newName ?? ''));
    case 'addForeignKey':
      return buildAddForeignKey({
        table: String(p.table ?? ''),
        column: String(p.column ?? ''),
        refTable: String(p.refTable ?? ''),
        refColumn: String(p.refColumn ?? ''),
        onDelete: String(p.onDelete ?? 'no action'),
      });
    case 'dropConstraint':
      return buildDropConstraint(String(p.table ?? ''), String(p.constraint ?? ''));
    case 'createJoinTable':
      return buildCreateJoinTable({
        tableA: String(p.tableA ?? ''),
        tableB: String(p.tableB ?? ''),
        name: p.name ? String(p.name) : undefined,
      });
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await jsonBody(request);
    if (!body) return bad('Invalid JSON body');
    const params = (body.params ?? {}) as Record<string, unknown>;

    const built = await build(String(body.action ?? ''), params);
    if (!built.ok) return bad(built.error);
    if (!body.execute) return ok({ sql: built.sql });

    /**
     * The preview IS the safety mechanism, so executing something other than what the
     * user was shown would hollow it out. The client echoes back the exact SQL string
     * it displayed; if a re-build no longer matches (params changed under a debounce,
     * or the catalog moved between preview and execute), refuse and return both so the
     * UI can show the new preview for re-confirmation.
     */
    const confirmed = typeof body.confirmSql === 'string' ? body.confirmSql : null;
    if (confirmed !== null && confirmed !== built.sql) {
      return ok(
        {
          sql: built.sql,
          error:
            'The statement changed since it was previewed — nothing ran. Review the updated SQL and run it again.',
          previewStale: true,
        },
        409
      );
    }

    const res = await executeDdl(built.sql);
    if (!res.ok) return ok({ sql: built.sql, error: res.error }, 400);
    return ok({ sql: built.sql, ok: true });
  } catch (e) {
    return oops(e);
  }
}
