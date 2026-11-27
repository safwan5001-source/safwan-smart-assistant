"use client";
/**
 * B3 — the inline card in the BASHT conversation: when a turn of THIS conversation (agent:main:app:owner) waits for the owner's
 * approval, the request appears right in the timeline with "سماح مرة واحدة" / "رفض" (each confirmed) and a countdown.
 * Other approvals (WhatsApp, automations) live in Notifications → «الموافقات». Polls faster while a turn is running.
 */
import { useEffect, useRef } from "react";
import { Notice } from "@/components/ui";
import { ApprovalCard, useApprovals, useNow } from "@/features/notifications/approvals";
import { answerable } from "@/lib/basht-approvals";

export default function ApprovalInlineCard({ active }: { active: boolean }) {
  const { view, approvals, refresh } = useApprovals(active ? 3000 : 20000);
  const now = useNow(1000);
  const mine = answerable(approvals, now, true);
  const box = useRef<HTMLDivElement>(null);
  const ids = mine.map((a) => a.id).join(",");
  // a new request must be seen: bring it into view at the bottom of the conversation
  useEffect(() => { if (ids) box.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [ids]);
  if (view === "down" && active) {
    return <div className="approval-inline"><Notice tone="warn" role="status">اتصال باشت بالمحرك منقطع الآن؛ إن احتاج موافقتك فلن تظهر هنا حتى يعود الاتصال.</Notice></div>;
  }
  if (!mine.length) return null;
  return (
    <div ref={box} className="approval-inline stack" role="region" aria-label="طلبات تنتظر موافقتك">
      {mine.map((a) => <ApprovalCard key={a.id} a={a} now={now} compact onDone={() => void refresh()} />)}
    </div>
  );
}
