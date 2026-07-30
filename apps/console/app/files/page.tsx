import { Suspense } from 'react';
import { LoadingState } from '@/ui/primitives';
import FilesBrowser from './FilesBrowser';

export const dynamic = 'force-dynamic';

export default function FilesPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<LoadingState />}>
        <FilesBrowser />
      </Suspense>
    </div>
  );
}
