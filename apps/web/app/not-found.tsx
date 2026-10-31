import Link from "next/link";
import { Empty } from "@/components/ui";

export default function NotFound() {
  return <div className="page"><div className="card"><Empty icon="search" title="الصفحة غير موجودة" action={<Link href="/" className="btn btn-primary">العودة للرئيسية</Link>}>الرابط الذي فتحته غير صحيح أو لم يعد متاحاً.</Empty></div></div>;
}
