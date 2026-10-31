import type { Metadata } from "next";
import { Suspense } from "react";
import FilesScreen from "@/features/files/files-screen";
import { ListSkeleton } from "@/components/ui";

export const metadata: Metadata = { title: "الملفات" };
export default function Page() {
  return <Suspense fallback={<div className="page"><ListSkeleton rows={3} /></div>}><FilesScreen /></Suspense>;
}
