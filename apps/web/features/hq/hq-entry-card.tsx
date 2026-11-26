import Link from "next/link";
import Icon from "@/components/icon";

/** Home-page entry to the HQ. Static (no 3D code): costs the home page a few hundred bytes. */
export default function HqEntryCard() {
  return (
    <Link href="/hq" className="hq-entry" aria-label="المقر التنفيذي الذكي — محاكاة تجريبية">
      <span className="hq-entry-art" aria-hidden="true">
        <svg viewBox="0 0 120 72" width="120" height="72">
          <path d="M8 46 60 18l52 28-52 26Z" fill="rgba(255,255,255,.16)" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
          <path d="M60 18v13l-40 21M60 31l40 21M38 30l22 11 22-11" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="1" />
          <path d="M52 22l8-4 8 4-8 4Z" fill="#f2c94c" />
          <circle cx="40" cy="47" r="2.2" fill="#fff" /><circle cx="78" cy="44" r="2.2" fill="#fff" /><circle cx="60" cy="57" r="2.2" fill="#67e8f9" />
        </svg>
      </span>
      <span className="grow">
        <small>جديد · محاكاة تجريبية</small>
        <strong>المقر التنفيذي الذكي</strong>
        <span className="hq-entry-sub">باشت و13 إدارة، مكتب لكل منها — تجوّل في المقر</span>
      </span>
      <Icon name="forward" size={18} />
    </Link>
  );
}
