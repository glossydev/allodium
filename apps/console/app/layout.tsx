import type { Metadata } from 'next';
import './globals.css';
import { Nav } from './nav';
import { tk } from '@/ui/tokens';

export const metadata: Metadata = {
  title: 'Allodium Console',
  description: 'Allodium developer console — build the site.',
};

function dbLabel(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    return `${u.pathname.slice(1) || '?'} @ ${u.hostname}:${u.port || '5432'}`;
  } catch {
    return 'no DATABASE_URL';
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${tk.page} antialiased`}>
        <div className="flex h-screen overflow-hidden">
          <aside className="flex w-[168px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
            <div className="border-b border-zinc-800 px-3 py-2.5">
              <h1 className={tk.h1}>
                allodium<span className={tk.accent}>_</span>
              </h1>
              <div className={`mt-0.5 truncate font-mono text-[10px] ${tk.faint}`} title={dbLabel()}>
                {dbLabel()}
              </div>
            </div>
            <Nav />
            <div className="border-t border-zinc-800 px-3 py-2 font-mono text-[10px] text-zinc-700">
              dev console · v0
            </div>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </body>
    </html>
  );
}
