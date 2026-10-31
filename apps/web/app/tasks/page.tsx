import type { Metadata } from "next";
import { Suspense } from "react";
import TasksScreen from "@/features/tasks/tasks-screen";
import { ListSkeleton } from "@/components/ui";

export const metadata: Metadata = { title: "المهام" };
export default function Page() {
  return <Suspense fallback={<div className="page"><ListSkeleton rows={3} /></div>}><TasksScreen /></Suspense>;
}
