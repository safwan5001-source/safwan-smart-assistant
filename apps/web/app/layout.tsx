import type { Metadata, Viewport } from "next";
import "./styles.css";
export const metadata: Metadata = { title: "مساعد صفوان الذكي", description: "المساعد الشخصي الذكي" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#10263f" };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
