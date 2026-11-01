import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AppShell from "@/components/app-shell";
import PreferencesEffects from "@/components/preferences-effects";
import { DialogsProvider } from "@/components/dialogs";
import { AssistantProvider } from "@/components/assistant-context";
import NotificationRuntime from "@/components/notification-runtime";

export const metadata: Metadata = {
  title: { default: "مساعد صفوان الذكي", template: "%s · مساعد صفوان" },
  description: "المساعد الشخصي الذكي: محادثات ومهام وملفات في مساحة واحدة.",
  applicationName: "مساعد صفوان",
  manifest: "/manifest.webmanifest",
  icons: { icon: [{ url: "/safwan-logo.svg", type: "image/svg+xml" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "صفوان", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f4f6fa" }, { media: "(prefers-color-scheme: dark)", color: "#080f19" }],
};

// Runs before first paint so the saved theme never flashes. Static string, no user input.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('safwan-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.dataset.theme=d?'dark':'light';r.dataset.compact=localStorage.getItem('safwan-compact')==='true'?'true':'false'}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT }} /></head>
      <body>
        <DialogsProvider>
          <PreferencesEffects />
          <NotificationRuntime />
          <AssistantProvider><AppShell>{children}</AppShell></AssistantProvider>
        </DialogsProvider>
      </body>
    </html>
  );
}
