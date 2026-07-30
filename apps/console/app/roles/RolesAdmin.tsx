'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { tk } from '@/ui/tokens';
import { fetchJson, ErrorBox, LoadingState, Modal } from '@/ui/primitives';

/**
 * Roles & Permissions — the UNIFIED editor (owner's decision: no Directus-style
 * policy indirection). Left: roles by rank. Right: the permission matrix —
 * every table × CRUD, staged edits, one save.
 */

interface Role {
  id: number;
  key: string;
  label: string;
  description: string | null;
  rank: number;
  members: number;
  grants: number;
}

interface Grant {
  table_name: string;
  can_create: boolean;
  can_read: boolean;
  can_update: boolean;
  can_delete: boolean;
}

type Action = 'can_create' | 'can_read' | 'can_update' | 'can_delete';
const ACTIONS: { key: Action; label: string }[] = [
  { key: 'can_create', label: 'C' },
  { key: 'can_read', label: 'R' },
  { key: 'can_update', label: 'U' },
  { key: 'can_delete', label: 'D' },
];

const emptyGrant = (table: string): Grant => ({
  table_name: table,
  can_create: false,
  can_read: false,
  can_update: false,
  can_delete: false,
});

export default function RolesAdmin() {
  const [data, setData] = useState<{ roles: Role[]; tables: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selId, setSelId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editRole, setEditRole] = useState<Role | null>(null);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ roles: Role[]; tables: string[] }>('/api/roles/overview').then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
        // Keep a valid selection.
        setSelId((prev) => (prev !== null && r.data.roles.some((x) => x.id === prev) ? prev : (r.data.roles[0]?.id ?? null)));
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const sel = useMemo(() => data?.roles.find((r) => r.id === selId) ?? null, [data, selId]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <LoadingState />;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Role list */}
      <aside className={`flex w-[260px] shrink-0 flex-col border-r ${tk.panel}`}>
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Roles by rank</span>
          <button onClick={() => setShowCreate(true)} className={tk.btn}>
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {data.roles.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelId(r.id)}
              className={`block w-full px-3 py-2 text-left ${selId === r.id ? 'bg-zinc-900' : 'hover:bg-zinc-900/60'}`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium ${selId === r.id ? 'text-emerald-300' : 'text-zinc-200'}`}>{r.label}</span>
                <span className={tk.badge}>rank {r.rank}</span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
                {r.key} · {r.members} member{r.members === 1 ? '' : 's'} · {r.grants} grant{r.grants === 1 ? '' : 's'}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Matrix */}
      {sel ? (
        <PermissionMatrix key={sel.id} role={sel} tables={data.tables} onChanged={refresh} onEditRole={() => setEditRole(sel)} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">Select a role</div>
      )}

      {showCreate && (
        <RoleFormModal
          onClose={() => setShowCreate(false)}
          onDone={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}
      {editRole && (
        <RoleFormModal
          existing={editRole}
          onClose={() => setEditRole(null)}
          onDone={() => {
            setEditRole(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------- Permission matrix ---------------------------- */

function PermissionMatrix({
  role,
  tables,
  onChanged,
  onEditRole,
}: {
  role: Role;
  tables: string[];
  onChanged: () => void;
  onEditRole: () => void;
}) {
  const [saved, setSaved] = useState<Map<string, Grant> | null>(null);
  const [staged, setStaged] = useState<Map<string, Grant>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Bumped after a successful save so the baseline is re-read from the database.
  // Without this the dirty bar stuck around post-save, Discard restored the
  // pre-save matrix, and the next Save silently reverted the change.
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ grants: Grant[] }>(`/api/roles/permissions?roleId=${role.id}`).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        const m = new Map(r.data.grants.map((g) => [g.table_name, g]));
        setSaved(m);
        setStaged(new Map(m));
        setError(null);
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [role.id, loadTick]);

  const isSuper = role.key === 'super_admin';

  const staleTables = useMemo(
    () => (saved ? [...saved.keys()].filter((t) => !tables.includes(t)) : []),
    [saved, tables]
  );

  const dirtyCount = useMemo(() => {
    if (!saved) return 0;
    let n = 0;
    const allNames = new Set([...tables, ...staleTables]);
    for (const t of allNames) {
      const a = saved.get(t) ?? emptyGrant(t);
      const b = staged.get(t) ?? emptyGrant(t);
      if (ACTIONS.some(({ key }) => a[key] !== b[key])) n++;
    }
    return n;
  }, [saved, staged, tables, staleTables]);

  const get = (t: string): Grant => staged.get(t) ?? emptyGrant(t);

  const toggle = (t: string, a: Action, v?: boolean) => {
    setStaged((prev) => {
      const next = new Map(prev);
      const g = { ...(next.get(t) ?? emptyGrant(t)) };
      g[a] = v ?? !g[a];
      next.set(t, g);
      return next;
    });
  };

  const setRow = (t: string, v: boolean) => {
    setStaged((prev) => {
      const next = new Map(prev);
      next.set(t, { table_name: t, can_create: v, can_read: v, can_update: v, can_delete: v });
      return next;
    });
  };

  const setColumn = (a: Action, v: boolean) => {
    setStaged((prev) => {
      const next = new Map(prev);
      for (const t of tables) {
        const g = { ...(next.get(t) ?? emptyGrant(t)) };
        g[a] = v;
        next.set(t, g);
      }
      return next;
    });
  };

  const grantReadAll = () => setColumn('can_read', true);
  const clearAll = () => {
    setStaged((prev) => {
      const next = new Map(prev);
      for (const t of [...tables, ...staleTables]) next.set(t, emptyGrant(t));
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const grants = [...new Set([...tables, ...staleTables])].map((t) => get(t));
    const r = await fetchJson('/api/roles/permissions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: role.id, grants }),
    });
    setSaving(false);
    if (r.ok) {
      setLoadTick((n) => n + 1); // re-read the baseline we just wrote
      onChanged(); // refresh grant counts in the role list
    } else setError(r.error);
  };

  const discard = () => saved && setStaged(new Map(saved));

  const colAllChecked = (a: Action) => tables.every((t) => get(t)[a]);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* Role header */}
      <div className={tk.toolbar}>
        <span className="text-sm font-semibold text-zinc-100">{role.label}</span>
        <span className={`font-mono text-xs ${tk.muted}`}>{role.key}</span>
        <button onClick={onEditRole} className={tk.btn2}>
          Edit role
        </button>
        <Link href={`/users?role=${role.key}`} className={`text-[11px] ${tk.link}`}>
          {role.members} member{role.members === 1 ? '' : 's'} →
        </Link>
        {!isSuper && (
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={grantReadAll} className={tk.btn2}>
              Grant read on all
            </button>
            <button onClick={clearAll} className={tk.btn2}>
              Clear all
            </button>
          </div>
        )}
      </div>

      {isSuper ? (
        <div className="m-4 max-w-lg rounded border border-zinc-800 bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-400">
          <span className="font-medium text-emerald-300">super_admin bypasses the permissions model</span> — it is the
          developer-console lane. Grants here would be misleading, so it deliberately has none. Every other role is
          governed by the matrix.
        </div>
      ) : !saved && !error ? (
        <LoadingState />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            {staleTables.length > 0 && (
              <div className={`m-3 ${tk.warn}`}>
                <div className="font-semibold">Schema drift: grants for tables that no longer exist</div>
                {staleTables.map((t) => (
                  <div key={t} className="mt-1 flex items-center gap-2">
                    <span className="font-mono line-through">{t}</span>
                    <button onClick={() => setRow(t, false)} className="text-amber-200 underline hover:text-amber-100">
                      remove grants
                    </button>
                  </div>
                ))}
              </div>
            )}
            <table className={tk.table}>
              <thead>
                <tr>
                  <th className={tk.th}>table</th>
                  {ACTIONS.map((a) => (
                    <th key={a.key} className={`${tk.th} w-16 text-center`}>
                      <label className="flex items-center justify-center gap-1">
                        {a.label}
                        <input
                          type="checkbox"
                          checked={colAllChecked(a.key)}
                          onChange={(e) => setColumn(a.key, e.target.checked)}
                          title={`toggle ${a.label} for all tables`}
                          className={tk.checkbox}
                        />
                      </label>
                    </th>
                  ))}
                  <th className={`${tk.th} w-14 text-center`}>all</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => {
                  const g = get(t);
                  const all = ACTIONS.every(({ key }) => g[key]);
                  return (
                    <tr key={t} className={tk.tr}>
                      <td className={`${tk.td} font-mono`}>{t}</td>
                      {ACTIONS.map((a) => (
                        <td key={a.key} className="w-16 px-2 py-1 text-center">
                          <input type="checkbox" checked={g[a.key]} onChange={() => toggle(t, a.key)} className={tk.checkbox} />
                        </td>
                      ))}
                      <td className="w-14 px-2 py-1 text-center">
                        <input type="checkbox" checked={all} onChange={(e) => setRow(t, e.target.checked)} className={tk.checkbox} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {error && <div className={`mx-3 mb-2 ${tk.err}`}>{error}</div>}

          {/* Sticky save bar */}
          {dirtyCount > 0 && (
            <div className="flex items-center gap-2 border-t border-emerald-900 bg-emerald-950/40 px-3 py-2">
              <span className="text-xs text-emerald-200">
                {dirtyCount} table{dirtyCount === 1 ? '' : 's'} changed
              </span>
              <button onClick={save} disabled={saving} className={`${tk.btn} ml-auto`}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={discard} disabled={saving} className={tk.btn2}>
                Discard
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

/* ------------------------------ Role form modal ------------------------------ */

function RoleFormModal({
  existing,
  onClose,
  onDone,
}: {
  existing?: Role;
  onClose: () => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState(existing?.key ?? '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [rank, setRank] = useState(String(existing?.rank ?? 100));
  const [deleteTyped, setDeleteTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const values: Record<string, unknown> = { label, description: description || null, rank };
    if (!existing) values.key = key;
    const r = await fetchJson('/api/content/row', {
      method: existing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(existing ? { table: 'roles', id: existing.id, values } : { table: 'roles', values }),
    });
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error);
  };

  const del = async () => {
    if (!existing) return;
    setBusy(true);
    setError(null);
    const r = await fetchJson('/api/content/row', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'roles', id: existing.id }),
    });
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error);
  };

  return (
    <Modal
      title={existing ? `Edit role: ${existing.label}` : 'New role'}
      onClose={onClose}
      footer={
        <>
          <button onClick={submit} disabled={busy || !label || (!existing && !key)} className={tk.btn}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Create role'}
          </button>
          <button onClick={onClose} className={tk.btn2}>
            Cancel
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400">
            key {existing && <span className="text-zinc-600">(immutable — it's what code checks)</span>}
          </label>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={!!existing}
            placeholder="snake_case"
            className={`${tk.input} mt-0.5 w-full font-mono`}
          />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={`${tk.input} mt-0.5 w-full`} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={`${tk.input} mt-0.5 w-full resize-y`}
          />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">rank (lower = more powerful)</label>
          <input value={rank} onChange={(e) => setRank(e.target.value)} className={`${tk.input} mt-0.5 w-24 font-mono`} />
        </div>

        {existing && (
          <div className="rounded border border-red-950 p-3">
            <div className="text-[11px] text-zinc-400">
              Deleting cascades: {existing.members} member grant{existing.members === 1 ? '' : 's'} and {existing.grants}{' '}
              permission row{existing.grants === 1 ? '' : 's'} are wiped. Type{' '}
              <span className="font-mono text-red-400">{existing.key}</span> to confirm.
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input value={deleteTyped} onChange={(e) => setDeleteTyped(e.target.value)} className={`${tk.input} flex-1 font-mono`} />
              <button onClick={del} disabled={deleteTyped !== existing.key || busy} className={tk.btnDanger}>
                Delete role
              </button>
            </div>
          </div>
        )}

        {error && <div className={tk.err}>{error}</div>}
      </div>
    </Modal>
  );
}
