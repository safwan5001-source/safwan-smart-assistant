"use client";
import { createContext, useContext, type ReactNode } from "react";
import { useAssistantStatus } from "@/lib/hooks";
import type { AssistantStatus } from "@/lib/assistant";

const Ctx = createContext<{ status: AssistantStatus; refresh: () => void }>({ status: { server: "checking" }, refresh: () => {} });
export const useAssistant = () => useContext(Ctx);
export function AssistantProvider({ children }: { children: ReactNode }) {
  const value = useAssistantStatus();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const aiReady = (s: AssistantStatus) => s.server === "online" && s.assistant;
