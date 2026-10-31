"use client";
import Icon from "@/components/icon";
import { OPEN_SEARCH_EVENT } from "@/components/app-shell";

export default function MoreSearchButton() {
  return (
    <button className="btn btn-block" style={{ justifyContent: "flex-start", color: "var(--muted)" }} onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}>
      <Icon name="search" size={18} />ابحث في كل شيء…
    </button>
  );
}
