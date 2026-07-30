import { Suspense } from 'react';
import { LoadingState } from '@/ui/primitives';
import ContentBrowser from './ContentBrowser';

export const dynamic = 'force-dynamic';

export default function ContentPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<LoadingState />}>
        <ContentBrowser />
      </Suspense>
    </div>
  );
}
