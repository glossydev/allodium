'use client';

import { useCallback, useEffect, useState } from 'react';
import { tk } from '@/ui/tokens';
import { fetchJson, NullMark, ErrorBox, EmptyState, LoadingState, SlideOver, Modal } from '@/ui/primitives';

/**
 * API tokens silo — the bearer tokens machine callers hold (a job runner, a
 * deploy box, an agent's tooling), managed in one place.
 *
 * Two shapes of token: one that ACTS AS A USER (its roles are the user's, read
 * at resolve time) and a SERVICE token with roles of its own and no user. The
 * plaintext is shown exactly once, at minting; the store keeps only a digest,
 * so there is nothing to reveal later and nothing here tries.
 */

interface TokenRow {
  id: string;
  label: string;
  userId: string | null;
  userEmail: string | null;
  roles: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
interface RoleSummary {
  id: number;
  key: string;
  label: string;
  rank: number;
}
interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
}

const when = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : null);
const EXPIRY: { label: string; days: number | null }[] = [
  { label: 'Never', days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
];

export default function TokensAdmin() {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [showRevoked, setShowRevoked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [revoking, setRevoking] = useState<TokenRow | null>(null);
  const [minted, setMinted] = useState<{ label: string; token: string } | null>(null);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson<{ rows: TokenRow[] }>(`/api/tokens/list${showRevoked ? '?revoked=1' : ''}`).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setRows(r.data.rows);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [showRevoked, tick]);

  const live = rows.filter((r) => !r.revokedAt).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={tk.toolbar}>
        <h1 className={tk.h1}>API tokens</h1>
        <span className={`ml-2 text-xs ${tk.muted}`}>{live} live</span>
        <label className={`ml-4 flex items-center gap-1.5 text-xs ${tk.muted}`}>
          <input type="checkbox" className={tk.checkbox} checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
          show revoked
        </label>
        <div className="flex-1" />
        <button className={tk.btn} onClick={() => setShowCreate(true)}>
          + New token
        </button>
      </div>

      {error && <ErrorBox error={error} />}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && rows.length === 0 ? (
          <LoadingState />
        ) : rows.length === 0 && !error ? (
          <EmptyState>No tokens yet. A token lets a job runner, a deploy box or an agent call your app as a user or as a set of roles.</EmptyState>
        ) : (
          <table className={tk.table}>
            <thead>
              <tr>
                <th className={tk.th}>label</th>
                <th className={tk.th}>acts as</th>
                <th className={tk.th}>created</th>
                <th className={tk.th}>expires</th>
                <th className={tk.th}>last used</th>
                <th className={tk.th}>status</th>
                <th className={tk.th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const expired = !!r.expiresAt && new Date(r.expiresAt).getTime() < Date.now();
                const dead = !!r.revokedAt || expired;
                return (
                  <tr key={r.id} className={`${tk.tr} ${dead ? 'opacity-60' : ''}`}>
                    <td className={`${tk.td} font-medium text-zinc-100`}>{r.label}</td>
                    <td className={`${tk.td} ${tk.mono}`}>
                      {r.userId ? (
                        <span>
                          user <span className={tk.accent}>{r.userEmail ?? r.userId}</span>
                        </span>
                      ) : (
                        <span>
                          service{' '}
                          {r.roles.map((k) => (
                            <span key={k} className={`${tk.badge} ml-1`}>
                              {k}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className={`${tk.td} ${tk.mono} ${tk.muted}`}>{when(r.createdAt)}</td>
                    <td className={`${tk.td} ${tk.mono} ${tk.muted}`}>{when(r.expiresAt) ?? <NullMark />}</td>
                    <td className={`${tk.td} ${tk.mono} ${tk.muted}`}>{when(r.lastUsedAt) ?? <span className={tk.faint}>never</span>}</td>
                    <td className={tk.td}>
                      {r.revokedAt ? (
                        <span className="text-red-300">revoked {when(r.revokedAt)}</span>
                      ) : expired ? (
                        <span className="text-amber-300">expired</span>
                      ) : (
                        <span className="text-emerald-300">live</span>
                      )}
                    </td>
                    <td className={`${tk.td} text-right`}>
                      {!r.revokedAt && (
                        <button className={tk.btnDanger} onClick={() => setRevoking(r)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className={tk.footer}>
        A token is shown once, at minting. The database keeps only its digest; a lost token is replaced, never recovered.
      </div>

      {showCreate && (
        <CreateToken
          onClose={() => setShowCreate(false)}
          onMinted={(m) => {
            setShowCreate(false);
            setMinted(m);
            refresh();
          }}
        />
      )}

      {minted && <ShowOnce minted={minted} onClose={() => setMinted(null)} />}

      {revoking && (
        <Modal
          title={`Revoke "${revoking.label}"?`}
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button className={tk.btn2} onClick={() => setRevoking(null)}>
                Keep it
              </button>
              <button
                className={tk.btnDanger}
                onClick={async () => {
                  const r = await fetchJson('/api/tokens/revoke', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: revoking.id }),
                  });
                  if (!r.ok) setError(r.error);
                  setRevoking(null);
                  refresh();
                }}
              >
                Revoke
              </button>
            </>
          }
        >
          <p className="text-xs text-zinc-300">
            Whatever holds this token stops working on its next request. There is no undo; mint a new one if it was a mistake.
          </p>
        </Modal>
      )}
    </div>
  );
}

function CreateToken({ onClose, onMinted }: { onClose: () => void; onMinted: (m: { label: string; token: string }) => void }) {
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'user' | 'service'>('user');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userQ, setUserQ] = useState('');
  const [userId, setUserId] = useState('');
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<number | null>(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ roles: RoleSummary[] }>('/api/users/roles-summary').then((r) => {
      if (r.ok) setRoles(r.data.roles);
    });
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams({ page: '1', pageSize: '20', status: 'active' });
      if (userQ) p.set('q', userQ);
      fetchJson<{ rows: UserRow[] }>(`/api/users/list?${p}`).then((r) => {
        if (r.ok) setUsers(r.data.rows);
      });
    }, 200);
    return () => clearTimeout(t);
  }, [userQ]);

  const canMint = label.trim() && (mode === 'user' ? !!userId : picked.size > 0) && !busy;

  const mint = async () => {
    setBusy(true);
    setError(null);
    const expiresAt = expiry === null ? null : new Date(Date.now() + expiry * 86_400_000).toISOString();
    const r = await fetchJson<{ id: string; token: string }>('/api/tokens/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode === 'user' ? { label, userId, expiresAt } : { label, roles: [...picked], expiresAt }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onMinted({ label: label.trim(), token: r.data.token });
  };

  return (
    <SlideOver
      title="New API token"
      onClose={onClose}
      footer={
        <>
          <button className={tk.btn} disabled={!canMint} onClick={mint}>
            {busy ? 'Minting…' : 'Mint token'}
          </button>
          <button className={tk.btn2} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="space-y-4 p-4 text-xs">
        {error && <div className={tk.err}>{error}</div>}
        <label className="block">
          <span className={tk.muted}>Label — what will hold it</span>
          <input className={`${tk.input} mt-1 w-full`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="nightly invoicing job" autoFocus />
        </label>

        <div>
          <span className={tk.muted}>Acts as</span>
          <div className="mt-1 flex gap-1.5">
            <button className={mode === 'user' ? tk.badgeAccent : `${tk.badge} hover:text-zinc-100`} onClick={() => setMode('user')}>
              a user
            </button>
            <button className={mode === 'service' ? tk.badgeAccent : `${tk.badge} hover:text-zinc-100`} onClick={() => setMode('service')}>
              a service with its own roles
            </button>
          </div>
        </div>

        {mode === 'user' ? (
          <div>
            <input className={`${tk.input} w-full`} value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="find an active user by email…" />
            <div className="mt-1 max-h-48 overflow-y-auto rounded border border-zinc-800">
              {users.length === 0 ? (
                <div className={`p-2 ${tk.faint}`}>No active users match.</div>
              ) : (
                users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => setUserId(u.id)}
                    className={`block w-full px-2 py-1 text-left ${tk.mono} ${userId === u.id ? 'bg-emerald-950/40 text-emerald-300' : 'hover:bg-zinc-800'}`}
                  >
                    {u.email}
                    {u.display_name && <span className={`ml-2 ${tk.muted}`}>{u.display_name}</span>}
                  </button>
                ))
              )}
            </div>
            <p className={`mt-1 ${tk.faint}`}>The token has whatever roles the user has at the time of each request.</p>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => (
                <label key={r.key} className={`flex items-center gap-1 ${tk.badge} cursor-pointer`}>
                  <input
                    type="checkbox"
                    className={tk.checkbox}
                    checked={picked.has(r.key)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(r.key);
                      else next.delete(r.key);
                      setPicked(next);
                    }}
                  />
                  {r.key}
                </label>
              ))}
            </div>
            <p className={`mt-1 ${tk.faint}`}>A service owns no rows: a grant on &ldquo;your own&rdquo; denies it. Give it table-wide grants.</p>
          </div>
        )}

        <div>
          <span className={tk.muted}>Expires</span>
          <div className="mt-1 flex gap-1.5">
            {EXPIRY.map((e) => (
              <button key={e.label} className={expiry === e.days ? tk.badgeAccent : `${tk.badge} hover:text-zinc-100`} onClick={() => setExpiry(e.days)}>
                {e.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </SlideOver>
  );
}

function ShowOnce({ minted, onClose }: { minted: { label: string; token: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title={`Token for "${minted.label}"`}
      onClose={onClose}
      footer={
        <button className={tk.btn} onClick={onClose}>
          I have stored it
        </button>
      }
    >
      <p className="mb-2 text-xs text-zinc-300">
        This is the only time the token is shown. Put it in the caller&rsquo;s secret store now; the database keeps only a digest.
      </p>
      <div className="flex items-center gap-2">
        <code className={`flex-1 break-all rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs ${tk.accent}`} data-testid="token-plaintext">
          {minted.token}
        </code>
        <button
          className={tk.btn2}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(minted.token);
              setCopied(true);
            } catch {
              /* clipboard may be unavailable; the token is still on screen */
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className={`mt-3 text-[11px] ${tk.faint}`}>
        Send it as <code>Authorization: Bearer …</code>. Your app&rsquo;s <code>actorFor</code> resolves it before the cookie.
      </p>
    </Modal>
  );
}
