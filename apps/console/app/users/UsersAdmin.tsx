'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { tk } from '@/ui/tokens';
import { PAGE_SIZE, fetchJson, NullMark, ErrorBox, EmptyState, LoadingState, SlideOver, Modal } from '@/ui/primitives';

/**
 * Users silo — user administration with ROLE as the primary lens (owner spec):
 * role chips filter the grid, the drawer's core action is grant/revoke.
 */

interface RoleGrant {
  key: string;
  label: string;
  rank: number;
  granted_at: string | null;
  granted_by: string | null;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  has_mfa: boolean;
  last_login_at: string | null;
  created_at: string;
  customer_id: number | null;
  roles: RoleGrant[];
}

interface RoleSummary {
  id: number;
  key: string;
  label: string;
  rank: number;
  members: number;
}

const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

const statusTone = (s: string) =>
  s === 'active' ? 'text-emerald-300' : s === 'invited' ? 'text-zinc-300' : 'text-red-300';

export default function UsersAdmin() {
  const router = useRouter();
  const params = useSearchParams();

  const roleFilter = params.get('role') ?? '';
  const statusFilter = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const [q, setQ] = useState(params.get('q') ?? '');
  const [debouncedQ, setDebouncedQ] = useState(q);
  const [summary, setSummary] = useState<{ roles: RoleSummary[]; totalUsers: number } | null>(null);
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [drawerUser, setDrawerUser] = useState<UserRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const setView = useCallback(
    (v: { role?: string; status?: string; page?: number; q?: string }) => {
      const p = new URLSearchParams();
      const role = v.role !== undefined ? v.role : roleFilter;
      const status = v.status !== undefined ? v.status : statusFilter;
      const search = v.q !== undefined ? v.q : debouncedQ;
      if (role) p.set('role', role);
      if (status) p.set('status', status);
      if (search) p.set('q', search);
      if ((v.page ?? 1) > 1) p.set('page', String(v.page));
      router.replace(`/users?${p.toString()}`);
    },
    [router, roleFilter, statusFilter, debouncedQ]
  );

  // Search changes reset pagination — but only for an ACTUAL change. Running on
  // mount rewrote the URL without `page`, so /users?page=2 deep links snapped back
  // to page 1 on every load.
  const lastSearch = useRef(debouncedQ);
  useEffect(() => {
    if (lastSearch.current === debouncedQ) return;
    lastSearch.current = debouncedQ;
    setView({ q: debouncedQ, page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ roles: RoleSummary[]; totalUsers: number }>('/api/users/roles-summary').then((r) => {
      if (!cancelled && r.ok) setSummary(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (roleFilter) p.set('role', roleFilter);
    if (statusFilter) p.set('status', statusFilter);
    if (debouncedQ) p.set('q', debouncedQ);
    fetchJson<{ rows: UserRow[]; total: number }>(`/api/users/list?${p.toString()}`).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setRows(r.data.rows);
        setTotal(r.data.total);
        setError(null);
        // Keep the open drawer in sync after grant/revoke refreshes. If the refreshed
        // page no longer contains that user (a filter change moved them, or they were
        // deleted), close the drawer rather than showing a stale snapshot whose
        // actions would fail confusingly.
        setDrawerUser((prev) => (prev ? (r.data.rows.find((u) => u.id === prev.id) ?? null) : prev));
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [page, roleFilter, statusFilter, debouncedQ, tick]);

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = (page - 1) * PAGE_SIZE + rows.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Role chips — the primary lens */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <button
          onClick={() => setView({ role: '', page: 1 })}
          className={roleFilter === '' ? tk.badgeAccent : `${tk.badge} hover:text-zinc-100`}
        >
          All {summary ? `· ${summary.totalUsers}` : ''}
        </button>
        {(summary?.roles ?? []).map((r) => (
          <button
            key={r.key}
            onClick={() => setView({ role: r.key, page: 1 })}
            title={r.label}
            className={roleFilter === r.key ? tk.badgeAccent : `${tk.badge} hover:text-zinc-100`}
          >
            {r.label} · {r.members}
          </button>
        ))}
        <select value={statusFilter} onChange={(e) => setView({ status: e.target.value, page: 1 })} className={`${tk.select} ml-3`}>
          <option value="">any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email or name…"
          className={`${tk.input} w-52`}
        />
        <button onClick={() => setShowCreate(true)} className={`${tk.btn} ml-auto`}>
          + New user
        </button>
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox error={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState>No users match</EmptyState>
        ) : (
          <table className={tk.table}>
            <thead>
              <tr>
                {['email', 'name', 'roles', 'status', 'mfa', 'last login', 'created'].map((h) => (
                  <th key={h} className={tk.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} onClick={() => setDrawerUser(u)} className={tk.trClickable}>
                  <td className={`${tk.td} font-mono`}>{u.email}</td>
                  <td className={tk.td}>{u.display_name ?? <NullMark />}</td>
                  <td className={tk.td}>
                    {u.roles.length === 0 ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <span key={r.key} className={tk.badgeAccent}>
                            {r.key}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className={`${tk.td} ${statusTone(u.status)}`}>{u.status}</td>
                  <td className={tk.td}>{u.has_mfa ? <span className={tk.accent}>●</span> : <span className="text-zinc-700">○</span>}</td>
                  <td className={`${tk.td} font-mono text-zinc-400`}>{u.last_login_at ?? <NullMark />}</td>
                  <td className={`${tk.td} font-mono text-zinc-400`}>{u.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={`flex items-center justify-between ${tk.footer}`}>
        <span>
          {rangeStart}–{rangeEnd} of {total}
          {loading ? ' · loading…' : ''}
        </span>
        <div className="flex items-center gap-1">
          <button disabled={page <= 1 || loading} onClick={() => setView({ page: page - 1 })} className={tk.btn2}>
            Prev
          </button>
          <button disabled={rangeEnd >= total || loading} onClick={() => setView({ page: page + 1 })} className={tk.btn2}>
            Next
          </button>
        </div>
      </div>

      {drawerUser && summary && (
        <UserDrawer user={drawerUser} roles={summary.roles} onClose={() => setDrawerUser(null)} onChanged={refresh} />
      )}
      {showCreate && summary && (
        <CreateUserModal
          roles={summary.roles}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------- User drawer ------------------------------- */

function UserDrawer({
  user,
  roles,
  onClose,
  onChanged,
}: {
  user: UserRow;
  roles: RoleSummary[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState(user.email);
  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [status, setStatus] = useState(user.status);
  const [grantRole, setGrantRole] = useState('');
  const [deleteTyped, setDeleteTyped] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync ONLY when the drawer switches to a different user. Keying on the whole
  // `user` object meant an unrelated refresh (a grant/revoke re-fetches the page)
  // replaced the object identity and wiped whatever the operator was typing.
  useEffect(() => {
    setEmail(user.email);
    setDisplayName(user.display_name ?? '');
    setStatus(user.status);
  }, [user.id]);

  const remaining = useMemo(() => roles.filter((r) => !user.roles.some((g) => g.key === r.key)), [roles, user.roles]);
  const dirty = email !== user.email || displayName !== (user.display_name ?? '') || status !== user.status;

  const call = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Failed');
    else onChanged();
  };

  const saveIdentity = () =>
    call(async () => {
      const values: Record<string, unknown> = {};
      if (email !== user.email) values.email = email;
      if (displayName !== (user.display_name ?? '')) values.display_name = displayName || null;
      if (status !== user.status) values.status = status;
      return fetchJson('/api/content/row', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: 'users', id: user.id, values }),
      });
    });

  const roleAction = (roleId: number, action: 'grant' | 'revoke') =>
    call(() =>
      fetchJson('/api/users/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, roleId, action }),
      })
    );

  const deleteUser = () =>
    call(async () => {
      const r = await fetchJson('/api/content/row', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: 'users', id: user.id }),
      });
      if (r.ok) onClose();
      return r;
    });

  return (
    <SlideOver title={<span className="font-mono">{user.email}</span>} onClose={onClose}>
      <div className="space-y-4 p-4">
        {/* Identity */}
        <div className="space-y-2.5">
          <div>
            <label className="text-[11px] font-medium text-zinc-400">email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className={`${tk.input} mt-0.5 w-full font-mono`} />
          </div>
          <div>
            <label className="text-[11px] font-medium text-zinc-400">display name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={`${tk.input} mt-0.5 w-full`} />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="text-[11px] font-medium text-zinc-400">status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${tk.select} mt-0.5 w-full`}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <button onClick={saveIdentity} disabled={!dirty || busy} className={tk.btn}>
              Save
            </button>
          </div>
          <div className={`text-[11px] ${tk.faint}`}>
            mfa: {user.has_mfa ? 'enrolled' : 'none'} · last login: {user.last_login_at ?? 'never'} · created {user.created_at}
          </div>
        </div>

        {/* Roles — the core action */}
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Roles</div>
          {user.roles.length === 0 ? (
            <div className={`mb-2 text-[11px] ${tk.muted}`}>No roles — this user has no admin surface.</div>
          ) : (
            <div className="mb-2 space-y-1.5">
              {user.roles.map((g) => (
                <div key={g.key} className="flex items-center gap-2 text-xs">
                  <span className={tk.badgeAccent}>{g.key}</span>
                  <span className={tk.faint}>
                    {g.granted_at ?? ''}
                    {g.granted_by ? ` by ${g.granted_by}` : ' · system'}
                  </span>
                  <button
                    onClick={() => {
                      const role = roles.find((r) => r.key === g.key);
                      if (!role) return;
                      if (g.key === 'super_admin' && !window.confirm('Revoke super_admin? This removes console-lane power.')) return;
                      roleAction(role.id, 'revoke');
                    }}
                    disabled={busy}
                    title="Revoke"
                    className="ml-auto text-zinc-600 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <select value={grantRole} onChange={(e) => setGrantRole(e.target.value)} className={`${tk.select} flex-1`}>
              <option value="">— add role —</option>
              {remaining.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  {r.label} ({r.key})
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (grantRole) {
                  roleAction(Number(grantRole), 'grant');
                  setGrantRole('');
                }
              }}
              disabled={!grantRole || busy}
              className={tk.btn}
            >
              Grant
            </button>
          </div>
        </div>

        {/* Cross-links */}
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Related</div>
          <Link href={`/content?table=user_roles&f=user_id:eq:${user.id}`} className={`block text-[11px] ${tk.link}`}>
            rows in user_roles →
          </Link>
          {user.customer_id !== null && (
            <Link href={`/content?table=customers&f=user_id:eq:${user.id}`} className={`block text-[11px] ${tk.link}`}>
              customer profile →
            </Link>
          )}
        </div>

        {/* Danger zone */}
        <div className="rounded border border-red-950 p-3">
          {!showDelete ? (
            <button onClick={() => setShowDelete(true)} className={tk.btnDanger}>
              Delete user…
            </button>
          ) : (
            <div className="space-y-2">
              <div className="text-[11px] text-zinc-400">
                type <span className="font-mono text-red-400">{user.email}</span> to confirm — role grants cascade, the
                customer profile survives unlinked
              </div>
              <input value={deleteTyped} onChange={(e) => setDeleteTyped(e.target.value)} className={`${tk.input} w-full font-mono`} />
              <div className="flex gap-2">
                <button onClick={deleteUser} disabled={deleteTyped !== user.email || busy} className={tk.btnDanger}>
                  Delete forever
                </button>
                <button onClick={() => setShowDelete(false)} className={tk.btn2}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <div className={`${tk.err} whitespace-pre-wrap`}>{error}</div>}
      </div>
    </SlideOver>
  );
}

/* ------------------------------ Create modal ------------------------------ */

function CreateUserModal({
  roles,
  onClose,
  onCreated,
}: {
  roles: RoleSummary[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState('invited');
  const [roleIds, setRoleIds] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    const r = await fetchJson('/api/users/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, displayName, status, roleIds: [...roleIds] }),
    });
    setBusy(false);
    if (r.ok) onCreated();
    else setError(r.error);
  };

  return (
    <Modal
      title="New user"
      onClose={onClose}
      footer={
        <>
          <button onClick={create} disabled={busy || !email.includes('@')} className={tk.btn}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
          <button onClick={onClose} className={tk.btn2}>
            Cancel
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400">email</label>
          <input autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className={`${tk.input} mt-0.5 w-full font-mono`} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">display name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={`${tk.input} mt-0.5 w-full`} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400">status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${tk.select} mt-0.5 w-full`}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-[11px] font-medium text-zinc-400">roles</div>
          <div className="mt-1 space-y-1">
            {roles.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={roleIds.has(r.id)}
                  onChange={(e) =>
                    setRoleIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(r.id);
                      else next.delete(r.id);
                      return next;
                    })
                  }
                  className={tk.checkbox}
                />
                {r.label} <span className="font-mono text-zinc-500">({r.key})</span>
              </label>
            ))}
          </div>
        </div>
        <p className={`text-[10px] ${tk.faint}`}>Password is set to a dev placeholder — credential flows land with @allodium/auth.</p>
        {error && <div className={tk.err}>{error}</div>}
      </div>
    </Modal>
  );
}
