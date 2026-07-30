import SqlConsole from './SqlConsole';

export const dynamic = 'force-dynamic';

export default function SqlPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SqlConsole />
    </div>
  );
}
