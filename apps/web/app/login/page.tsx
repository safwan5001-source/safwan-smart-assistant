import type { Metadata } from "next";
import { Suspense } from "react";
import LoginScreen from "@/features/auth/login-screen";

export const metadata: Metadata = { title: "تسجيل الدخول", robots: { index: false, follow: false } };

export default function LoginPage() {
  return <Suspense fallback={null}><LoginScreen /></Suspense>;
}
