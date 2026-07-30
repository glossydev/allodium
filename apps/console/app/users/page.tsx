import { Suspense } from 'react';
import { LoadingState } from '@/ui/primitives';
import UsersAdmin from './UsersAdmin';

export const dynamic = 'force-dynamic';

export default function UsersPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<LoadingState />}>
        <UsersAdmin />
      </Suspense>
    </div>
  );
}
