import type { Metadata } from "next";
import { Suspense } from "react";
import IntegrationsScreen from "@/features/integrations/integrations-screen";
import { ListSkeleton } from "@/components/ui";

export const metadata: Metadata = { title: "التكاملات" };
export default function Page() {
  return <Suspense fallback={<div className="page"><ListSkeleton rows={3} h={120} /></div>}><IntegrationsScreen /></Suspense>;
}
