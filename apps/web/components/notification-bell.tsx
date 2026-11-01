"use client";
import Link from "next/link";
import Icon from "./icon";
import { useHydrated, useStore } from "@/lib/hooks";
import { noticesStore } from "@/lib/stores";
import { unreadCount } from "@/lib/notifications";

export default function NotificationBell() {
  const hydrated = useHydrated();
  const n = unreadCount(useStore(noticesStore));
  const count = hydrated ? n : 0;
  return (
    <Link href="/notifications" className="icon-btn bordered bell" aria-label={count ? `الإشعارات — ${count} غير مقروءة` : "الإشعارات"}>
      <Icon name="bell" size={20} />
      {count > 0 && <span className="bell-badge num" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
    </Link>
  );
}
