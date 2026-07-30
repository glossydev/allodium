import { Suspense } from 'react';
import { LoadingState } from '@/ui/primitives';
import SchemaBrowser from './SchemaBrowser';

export const dynamic = 'force-dynamic';

export default function SchemaPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<LoadingState />}>
        <SchemaBrowser />
      </Suspense>
    </div>
  );
}
