import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AppShell from "@/components/app-shell";
import PreferencesEffects from "@/components/preferences-effects";
import { DialogsProvider } from "@/components/dialogs";
import { AssistantProvider } from "@/components/assistant-context";
import NotificationRuntime from "@/components/notification-runtime";
import { BRAND, BRAND_ASSETS, splashImages } from "@/lib/brand";

export const metadata: Metadata = {
  title: { default: BRAND.full, template: `%s · ${BRAND.nameAr}` },
  description: BRAND.description,
  applicationName: BRAND.nameAr,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: BRAND_ASSETS.appleTouch, sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: BRAND.nameAr, statusBarStyle: "default", startupImage: splashImages() },
  openGraph: { title: BRAND.full, description: BRAND.description, siteName: BRAND.full, locale: "ar_SA", type: "website" },
  twitter: { card: "summary_large_image", title: BRAND.full, description: BRAND.description },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f8f7fd" }, { media: "(prefers-color-scheme: dark)", color: "#100b1e" }],
};

// Runs before first paint so the saved theme never flashes. Static string, no user input. Keys are the historical ones on purpose.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('safwan-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.dataset.theme=d?'dark':'light';r.dataset.compact=localStorage.getItem('safwan-compact')==='true'?'true':'false'}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="preload" href="/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        {/* Installed-app launch bridge: CSS-only, shown in standalone mode on a cold start, fades out on its own. */}
        <div className="boot-splash" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="boot-mark" src={BRAND_ASSETS.mark} alt="" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="boot-word on-light" src={BRAND_ASSETS.wordmark} alt="" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="boot-word on-dark" src={BRAND_ASSETS.wordmarkWhite} alt="" />
        </div>
        <DialogsProvider>
          <PreferencesEffects />
          <NotificationRuntime />
          <AssistantProvider><AppShell>{children}</AppShell></AssistantProvider>
        </DialogsProvider>
      </body>
    </html>
  );
}
