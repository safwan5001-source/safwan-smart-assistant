import type { Metadata } from "next";
import { Suspense } from "react";
import NotificationsScreen from "@/features/notifications/notifications-screen";
import { ListSkeleton } from "@/components/ui";
export const metadata: Metadata = { title: "الإشعارات" };
export default function Page() {
  return <Suspense fallback={<div className="page"><ListSkeleton rows={4} /></div>}><NotificationsScreen /></Suspense>;
}
