import { Suspense } from 'react';
import { LoadingState } from '@/ui/primitives';
import TokensAdmin from './TokensAdmin';

export const dynamic = 'force-dynamic';

export default function TokensPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<LoadingState />}>
        <TokensAdmin />
      </Suspense>
    </div>
  );
}
