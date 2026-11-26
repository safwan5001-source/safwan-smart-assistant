import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HQ_ENABLED } from "@/lib/hq/flag";
import HqScreen from "@/features/hq/hq-screen";

export const metadata: Metadata = { title: "المقر" };

/** BASHT HQ — off unless the build enables it (NEXT_PUBLIC_HQ_ENABLED=1); the 3D view inside is loaded on demand. */
export default function Page() {
  if (!HQ_ENABLED) notFound();
  return <HqScreen />;
}
