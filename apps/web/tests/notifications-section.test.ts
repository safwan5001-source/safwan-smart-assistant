import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The URL the screen sees. A notification tapped while /notifications is open is a query-only navigation: the component re-renders
// with new search params and is NOT remounted, so the section must follow the params on every render (Codex review, PR #62).
let query = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => query, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const { default: NotificationsScreen } = await import("@/features/notifications/notifications-screen");
const { DialogsProvider } = await import("@/components/dialogs");
const { sectionFromQuery } = await import("@/lib/basht-approvals");
const render = () => renderToStaticMarkup(createElement(DialogsProvider, null, createElement(NotificationsScreen)));
const pressed = (html: string) => [...html.matchAll(/<button class="chip" aria-pressed="true">.*?<\/svg>([^<]+)<\/button>/g)].map((m) => m[1]);

describe("Notifications: «الموافقات» follows the URL", () => {
  it("renders the section the current query asks for, and switches when only the query changes", () => {
    query = new URLSearchParams("");
    const a = render();
    expect(pressed(a)).toEqual(["الإشعارات"]);
    expect(a).not.toContain('aria-label="الموافقات"');
    query = new URLSearchParams("tab=approvals&focus=2f075550-246c-4742-97d7-5268e18d63d2");
    const b = render();
    expect(pressed(b)).toEqual(["الموافقات"]);
    expect(b).toContain('aria-label="الموافقات"');
    query = new URLSearchParams("");
    expect(pressed(render())).toEqual(["الإشعارات"]);
  });
  it("sectionFromQuery: approvals + a valid focus id only", () => {
    expect(sectionFromQuery(new URLSearchParams("tab=approvals&focus=2f075550-246c-4742-97d7-5268e18d63d2"))).toEqual({ section: "approvals", focus: "2f075550-246c-4742-97d7-5268e18d63d2" });
    expect(sectionFromQuery(new URLSearchParams("tab=approvals&focus=<script>"))).toEqual({ section: "approvals", focus: null });
    expect(sectionFromQuery(new URLSearchParams("focus=2f075550-246c-4742-97d7-5268e18d63d2"))).toEqual({ section: "notices", focus: null });
    expect(sectionFromQuery(null)).toEqual({ section: "notices", focus: null });
  });
});
