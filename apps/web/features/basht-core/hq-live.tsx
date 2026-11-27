"use client";
import { useAssistant } from "@/components/assistant-context";
import HqScreen from "@/features/hq/hq-screen";
import type { CoreView } from "@/lib/hq/source";

/** The only bridge between the app's status and the HQ: reads BASHT's engine state from the shared /api/health result and hands it in as a prop. */
export default function HqLive() {
  const { status } = useAssistant();
  const core: CoreView = status.server === "online" ? status.basht : status.server === "offline" ? "offline" : "checking";
  return <HqScreen core={core} />;
}
