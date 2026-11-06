import Link from "next/link";
import { Empty } from "@/components/ui";

export default function NotFound() {
  return <div className="page"><div className="card"><Empty icon="search" brand title="لم يجد باشت هذه الصفحة" action={<Link href="/" className="btn btn-primary">العودة إلى مركز القيادة</Link>}>الرابط الذي فتحته غير صحيح أو لم يعد متاحًا.</Empty></div></div>;
}
