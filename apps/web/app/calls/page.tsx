import type { Metadata } from "next";
import CallsScreen from "@/features/calls/calls-screen";

export const metadata: Metadata = { title: "المكالمات" };
export default function Page() { return <CallsScreen />; }
