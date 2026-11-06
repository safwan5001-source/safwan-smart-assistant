import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // `id` and `start_url` are unchanged so an installed copy updates in place instead of becoming a second app.
    id: "/",
    name: BRAND.full,
    short_name: BRAND.nameAr,
    description: BRAND.description,
    lang: "ar", dir: "rtl", start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
    background_color: "#f8f7fd", theme_color: "#4c1d95",
    categories: ["productivity", "business"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "محادثة مع باشت", short_name: "محادثة", url: "/chat", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "المهام", url: "/tasks", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "التذكيرات", url: "/reminders", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
