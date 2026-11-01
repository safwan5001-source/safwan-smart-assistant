import type { Metadata } from "next";
import { Suspense } from "react";
import RemindersScreen from "@/features/reminders/reminders-screen";
import { ListSkeleton } from "@/components/ui";
export const metadata: Metadata = { title: "التذكيرات" };
export default function Page() {
  return <Suspense fallback={<div className="page"><ListSkeleton rows={3} /></div>}><RemindersScreen /></Suspense>;
}
