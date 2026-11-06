import { BrandMark, ListSkeleton } from "@/components/ui";

export default function Loading() {
  return (
    <div className="page">
      <div className="loading-brand" role="status" aria-label="جارٍ التحميل"><BrandMark size="md" /><span className="typing" aria-hidden="true"><i /><i /><i /></span></div>
      <ListSkeleton rows={3} h={72} />
    </div>
  );
}
