/**
 * Design tokens for the developer console — dark, dense, monospace-leaning.
 * (The generated admin dashboard is the friendly light lane; this is the dev lane.)
 *
 * Silo agents: compose UI from these constants, never raw color classes, so the
 * whole console retheme stays a one-file change.
 */

export const tk = {
  /* Surfaces */
  page: 'bg-zinc-950 text-zinc-200',
  panel: 'bg-zinc-900 border-zinc-800',
  panelHeader: 'border-b border-zinc-800 bg-zinc-900',
  toolbar: 'flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-2',
  footer: 'border-t border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[11px] text-zinc-500',

  /* Text */
  h1: 'text-sm font-semibold text-zinc-100',
  muted: 'text-zinc-500',
  faint: 'text-zinc-600',
  mono: 'font-mono',
  err: 'rounded border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300',
  warn: 'rounded border border-amber-900 bg-amber-950/60 px-3 py-2 text-xs text-amber-300',

  /* Controls */
  btn: 'rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40',
  btn2: 'rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40',
  btnDanger: 'rounded border border-red-900 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-950 disabled:opacity-40',
  input:
    'rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:border-emerald-600 focus:outline-none disabled:bg-zinc-900 disabled:text-zinc-600',
  select:
    'rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:border-emerald-600 focus:outline-none disabled:opacity-40',
  checkbox: 'accent-emerald-600',

  /* Grids (dense data tables) */
  table: 'w-full border-collapse text-xs',
  th: 'sticky top-0 z-10 whitespace-nowrap border-b border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left font-medium text-zinc-400',
  thSortable:
    'sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left font-medium text-zinc-400 hover:text-zinc-100',
  tr: 'border-b border-zinc-800/60 hover:bg-zinc-900',
  trClickable: 'cursor-pointer border-b border-zinc-800/60 hover:bg-emerald-950/30',
  td: 'max-w-[16rem] truncate px-2 py-1 align-top',

  /* Accents */
  accent: 'text-emerald-400',
  link: 'text-emerald-400 hover:underline',
  badge: 'rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300',
  badgeAccent: 'rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300',
  pk: 'rounded bg-emerald-950 px-1 py-0.5 text-[9px] font-medium text-emerald-300',

  /* Nav */
  navItem: 'block w-full px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
  navItemActive: 'block w-full bg-zinc-900 px-3 py-1.5 text-left text-sm font-medium text-emerald-400',
} as const;
