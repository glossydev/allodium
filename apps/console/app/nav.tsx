'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tk } from '@/ui/tokens';

const SILOS: { href: string; label: string }[] = [
  { href: '/schema', label: 'Schema' },
  { href: '/content', label: 'Content' },
  { href: '/users', label: 'Users' },
  { href: '/roles', label: 'Roles & Permissions' },
  { href: '/files', label: 'Files' },
  { href: '/sql', label: 'SQL' },
  { href: '/admin-builder', label: 'Admin Builder' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex-1 overflow-y-auto py-1">
      {SILOS.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          className={pathname.startsWith(s.href) ? tk.navItemActive : tk.navItem}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
