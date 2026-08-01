import { Suspense } from 'react';
import { LoadingState } from '@/ui/primitives';
import AdminBuilder from './AdminBuilder';

export const dynamic = 'force-dynamic';

export default function AdminBuilderPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<LoadingState />}>
        <AdminBuilder />
      </Suspense>
    </div>
  );
}
