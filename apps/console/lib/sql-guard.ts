import 'server-only';

/**
 * Statement-boundary guard for the SQL silo.
 *
 * WHY THIS EXISTS (a scar, documented so it is never re-introduced): the read-only
 * sandbox originally relied ONLY on `set transaction read only` + `set local
 * statement_timeout` as the transaction's first statements. That is NOT structural.
 * node-pg's simple query protocol executes multiple `;`-separated statements in one
 * round trip, so a query of the form
 *
 *     set transaction read write; insert into ...; commit;
 *
 * lifted the read-only barrier, and the trailing `commit` persisted the write before
 * the handler's unconditional rollback could run. Verified exploitable before this
 * guard existed. The same trick reset statement_timeout to disable the DoS cap.
 *
 * Defense is now layered:
 *   1. this guard rejects multi-statement input, so the SET guards cannot be
 *      overridden or a COMMIT smuggled in;
 *   2. the read-only transaction + timeout still wrap the single statement;
 *   3. when CONSOLE_RO_DATABASE_URL is configured, the query runs as a role with
 *      only SELECT privileges — and privileges, unlike SET, cannot be overridden
 *      from inside the session.
 *
 * The scanner tracks every Postgres literal/comment form so a semicolon inside a
 * string, identifier, comment, or dollar-quoted body is not mistaken for a
 * statement boundary.
 */

export interface GuardResult {
  ok: boolean;
  error?: string;
}

export function assertSingleStatement(sql: string): GuardResult {
  let i = 0;
  const n = sql.length;
  let sawTerminator = false;

  while (i < n) {
    const ch = sql[i];

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }

    // /* block comment */ (Postgres nests them)
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }

    // 'string literal' with '' escapes
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      continue;
    }

    // "quoted identifier" with "" escapes
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      continue;
    }

    // E'...' / e'...' escape strings (backslash escapes)
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'") {
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      continue;
    }

    // $$ or $tag$ dollar-quoted body
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }

    // A statement terminator at depth zero.
    if (ch === ';') {
      sawTerminator = true;
      i++;
      // Anything but trailing whitespace/comments after it means a second statement.
      const rest = stripTrailing(sql.slice(i));
      if (rest.length > 0) {
        return {
          ok: false,
          error:
            'Only one statement per run. Multiple statements are refused because they could override the read-only transaction and the statement timeout.',
        };
      }
      break;
    }

    i++;
  }

  void sawTerminator;
  return { ok: true };
}

/** Remove trailing whitespace and comment-only tail so `select 1; -- done` passes. */
function stripTrailing(s: string): string {
  let t = s.trim();
  for (;;) {
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n');
      t = nl < 0 ? '' : t.slice(nl + 1).trim();
      continue;
    }
    if (t.startsWith('/*')) {
      let depth = 1;
      let i = 2;
      while (i < t.length && depth > 0) {
        if (t[i] === '/' && t[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (t[i] === '*' && t[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      t = t.slice(i).trim();
      continue;
    }
    if (t === ';') {
      t = '';
      continue;
    }
    return t;
  }
}
