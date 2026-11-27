"use client";
/** Renders its children everywhere except the login page: nothing of the app (reminders, notices) runs before sign-in. */
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LOGIN_PATH } from "@/lib/login-path";

export default function AppOnly({ children }: { children: ReactNode }) {
  return usePathname() === LOGIN_PATH ? null : <>{children}</>;
}
