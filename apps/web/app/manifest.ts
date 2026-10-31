import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "مساعد صفوان الذكي",
    short_name: "صفوان",
    description: "المساعد الشخصي الذكي: محادثات ومهام وملفات.",
    lang: "ar", dir: "rtl", start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
    background_color: "#f4f6fa", theme_color: "#0b2d5c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
