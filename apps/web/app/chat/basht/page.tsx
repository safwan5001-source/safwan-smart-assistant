import type { Metadata } from "next";
import BashtChatScreen from "@/features/basht-core/basht-chat-screen";

export const metadata: Metadata = { title: "باشت" };
export default function Page() {
  return <BashtChatScreen />;
}
