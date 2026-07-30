import { Suspense } from 'react';
import { LoadingState } from '@/ui/primitives';
import RolesAdmin from './RolesAdmin';

export const dynamic = 'force-dynamic';

export default function RolesPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<LoadingState />}>
        <RolesAdmin />
      </Suspense>
    </div>
  );
}
