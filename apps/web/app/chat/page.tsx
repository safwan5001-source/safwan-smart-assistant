import type { Metadata } from "next";
import { Suspense } from "react";
import ChatScreen from "@/features/chat/chat-screen";
import { ListSkeleton } from "@/components/ui";

export const metadata: Metadata = { title: "المحادثات" };
export default function Page() {
  return <Suspense fallback={<div className="page"><ListSkeleton rows={4} h={56} /></div>}><ChatScreen /></Suspense>;
}
