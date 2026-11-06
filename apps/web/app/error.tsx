"use client";
import { Empty } from "@/components/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page"><div className="card" role="alert">
      <Empty icon="alert" brand title="تعثّر باشت في عرض هذه الصفحة" action={<button className="btn btn-primary" onClick={reset}>إعادة المحاولة</button>}>
        لم تتأثر بياناتك المحفوظة على هذا الجهاز. إن تكرر الخطأ فأعد تحميل الصفحة.</Empty>
    </div></div>
  );
}
