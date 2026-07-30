import AdminBuilderPreview from './AdminBuilderPreview';

export const dynamic = 'force-dynamic';

export default function AdminBuilderPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AdminBuilderPreview />
    </div>
  );
}
