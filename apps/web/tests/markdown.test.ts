import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessageBody from "@/features/chat/message-body";
import { codeLanguage, isAppPath, isPlainText, markdownUrl, safeHref, textDirection } from "@/lib/markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const html = (text: string) => renderToStaticMarkup(createElement(MessageBody, { text }));
/** Every href / src the renderer emitted. */
const urls = (h: string) => [...h.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]);

describe("lib/markdown — link and image rules", () => {
  it.each(["https://example.com/a?b=1", "http://example.com", "mailto:owner@example.com", "tel:+966500000000"])("allows %s", (u) => expect(safeHref(u)).toBe(u));
  it.each([
    "javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "java​script:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "vbscript:msgbox(1)", "file:///etc/passwd", "//evil.test/x", "/relative", "#top",
    "https://", "", null, undefined,
  ])("refuses %j", (u) => expect(safeHref(u as string)).toBeNull());
  it("app-served paths only", () => {
    expect(isAppPath("/brand/mark.png")).toBe(true);
    for (const u of ["//evil.test/x.png", "/\\evil.test/x.png", "https://evil.test/x.png", "data:image/png;base64,AAAA", "x.png", ""]) expect(isAppPath(u)).toBe(false);
  });
  it("urlTransform blanks unsafe URLs", () => {
    expect(markdownUrl("javascript:alert(1)", "href")).toBe("");
    expect(markdownUrl("data:image/svg+xml,<svg onload=alert(1)>", "src")).toBe("");
    expect(markdownUrl("/brand/mark.png", "src")).toBe("/brand/mark.png");
    expect(markdownUrl("https://example.com", "href")).toBe("https://example.com");
  });
  it("code language labels stay short and plain", () => {
    expect(codeLanguage("language-TypeScript")).toBe("typescript");
    expect(codeLanguage("language-c++")).toBe("c++");
    expect(codeLanguage("language-<script>")).toBe("");
    expect(codeLanguage(undefined)).toBe("");
  });
});

describe("plain-text fast path", () => {
  const PLAIN = ["الطلب 1042 جاهز.", "مرحبا\nسطر ثانٍ", "فقرة أولى.\n\n  \nفقرة ثانية: المبلغ 1,250 ر.س (تقريبًا)؟", "Hello, world 42; ok", "رقم الهاتف 0500000000", "INV-1042 – مدفوعة"];
  const MARKDOWN = ["**x**", "a_b_", "`x`", "~x~", "[a](b)", "<b>", "a | b", "# x", "&lt;", "- x", "+ x", "x\n---", "x\n===", "1. x", "2) x", "    code", "\tcode",
    "https://example.com", "www.example.com", "owner@example.com", "a\\b", "> q"];
  it.each(PLAIN)("plain: %j", (t) => expect(isPlainText(t)).toBe(true));
  it.each(MARKDOWN)("needs the parser: %j", (t) => expect(isPlainText(t)).toBe(false));
  it.each(PLAIN)("renders exactly what the parser renders: %j", (t) => {
    const parsed = renderToStaticMarkup(createElement("div", { className: "md-body" }, createElement(Markdown, { remarkPlugins: [remarkGfm], components: { p: ({ children }) => createElement("p", { dir: "auto" }, children) } }, t)));
    expect(html(t)).toBe(parsed.replace(/>\n</g, "><"));
  });
});

describe("MessageBody — XSS attempts", () => {
  it("never emits raw HTML: <script>, event handlers, iframes are shown as text", () => {
    const h = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<iframe src="https://evil.test"></iframe> <b onmouseover=alert(1)>x</b>');
    expect(h).not.toMatch(/<script|<iframe|<img|<b[\s>]/i);
    expect(h).not.toMatch(/<[^>]*\son\w+=/i); // handler text may show, never as an attribute
    expect(h).toContain("&lt;script&gt;");
  });
  it("javascript:, data: and vbscript: links are not links", () => {
    for (const md of ["[click](javascript:alert(1))", "[click](JaVaScRiPt:alert(1))", "[click](data:text/html,<script>alert(1)</script>)",
      "[click](vbscript:msgbox)", "[click][r]\n\n[r]: javascript:alert(1)", "<javascript:alert(1)>"]) {
      const h = html(md);
      expect(h, md).not.toContain("<a ");
      expect(urls(h), md).toEqual([]);
    }
  });
  it("safe links open in a new tab without an opener", () => {
    const h = html("see [docs](https://example.com/docs) or mail owner@example.com or www.example.com");
    expect(h).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(h).toContain('href="mailto:owner@example.com"');
    for (const u of urls(h)) expect(safeHref(u)).not.toBeNull();
    for (const a of h.match(/<a [^>]*>/g) ?? []) expect(a).toContain('rel="noopener noreferrer"');
  });
  it("remote and data: images are never loaded; an app image is", () => {
    const remote = html("![chart](https://evil.test/pixel.png)");
    expect(remote).not.toContain("<img");
    expect(remote).toContain('href="https://evil.test/pixel.png"');
    expect(remote).toContain("chart");
    const data = html("![x](data:image/svg+xml;base64,PHN2Zz4=)");
    expect(data).not.toMatch(/<img|data:/);
    const local = html("![الشعار](/brand/mark.png)");
    expect(local).toMatch(/<img[^>]+src="\/brand\/mark.png"[^>]+loading="lazy"/);
  });
});

describe("MessageBody — Markdown", () => {
  it("headings, emphasis, lists (nested, numbered), quotes, rules, inline code", () => {
    const h = html("# عنوان\n\n## فرعي\n\nنص **عريض** و*مائل* و`code`.\n\n1. أول\n2. ثاني\n   - فرعي أ\n   - فرعي ب\n\n> اقتباس\n\n---\n\n- [x] منجز");
    expect(h).toContain('<h3 dir="auto" class="md-h1">عنوان</h3>');
    expect(h).toContain('<h4 dir="auto" class="md-h2">فرعي</h4>');
    expect(h).toContain("<strong>عريض</strong>");
    expect(h).toContain("<em>مائل</em>");
    expect(h).toContain('<code dir="ltr">code</code>');
    expect(h).toMatch(/<ol>\s*<li dir="rtl">أول<\/li>/);
    expect(h).toMatch(/<li dir="rtl">ثاني\s*<ul>\s*<li dir="rtl">فرعي أ<\/li>/);
    expect(h).toContain('<blockquote dir="rtl">');
    expect(h).toContain("<hr/>");
    expect(h).toContain('type="checkbox"');
    expect(h).not.toMatch(/<h[12][\s>]/); // a message never adds a page-level heading
  });
  it("paragraphs decide their own direction", () => {
    expect(html("مرحبا\n\nHello world 42")).toBe('<div class="md-body"><p dir="auto">مرحبا</p><p dir="auto">Hello world 42</p></div>');
    expect(html("**مرحبا**\n\nHello `x`")).toBe('<div class="md-body"><p dir="auto"><strong>مرحبا</strong></p>\n<p dir="auto">Hello <code dir="ltr">x</code></p></div>');
  });
  it("GFM tables scroll inside a labelled region and take the direction of their text", () => {
    const h = html("| البند | المبلغ |\n|---|---:|\n| فاتورة INV-1 | 1,250.00 |");
    expect(h).toContain('<div class="md-table" role="region" aria-label="جدول" tabindex="0" dir="rtl"><table>');
    expect(h).toMatch(/<th>البند<\/th>/);
    expect(h).toMatch(/<td style="text-align:right">1,250.00<\/td>/);
    expect(html("| Item | Qty |\n|---|---|\n| Railway | 1 |")).toContain('dir="ltr"><table>');
  });
  it("containers whose text sits in paragraphs still get the right direction (loose lists, quotes)", () => {
    const h = html("- أول\n\n- ثاني\n\n> اقتباس\n>\n> سطر\n\n- First item\n\n- Second");
    expect(h).toMatch(/<li dir="rtl">\s*<p dir="auto">أول<\/p>/);
    expect(h).toContain('<blockquote dir="rtl">');
    expect(h).toMatch(/<li dir="ltr">\s*<p dir="auto">First item<\/p>/);
    expect(textDirection("123 — مرحبا")).toBe("rtl");
    expect(textDirection("42 OK مرحبا")).toBe("ltr");
    expect(textDirection("123 ...")).toBeUndefined();
  });
  it("fenced code: language label, copy button, LTR pre, content escaped", () => {
    const h = html("```python\nprint('<b>hi</b>')\n```");
    expect(h).toContain('<bdi class="md-code-lang">python</bdi>');
    expect(h).toContain('aria-label="نسخ الكود"');
    expect(h).toContain("<pre dir=\"ltr\" tabindex=\"0\"><code>print(&#x27;&lt;b&gt;hi&lt;/b&gt;&#x27;)</code></pre>");
    const plain = html("```\nls -la\n```");
    expect(plain).toContain('<bdi class="md-code-lang">كود</bdi>');
  });
  it("an unclosed fence while streaming renders as code, not broken markup", () => {
    const h = html("الخطوات:\n\n```js\nconst a = 1;\nconst b = <");
    expect(h).toContain('<p dir="auto">الخطوات:</p>');
    expect(h).toContain('<bdi class="md-code-lang">js</bdi>');
    expect(h).toContain("<code>const a = 1;\nconst b = &lt;</code>");
    // and half-written emphasis / links stay readable text
    expect(html("**نص غير مكتمل")).toContain("**نص غير مكتمل");
    const partial = html("[رابط](https://exa");
    expect(partial).toContain("[رابط](");
    for (const u of urls(partial)) expect(safeHref(u)).not.toBeNull();
  });
  it("plain text replies render as plain paragraphs", () => {
    expect(html("الطلب 1042 جاهز.")).toBe('<div class="md-body"><p dir="auto">الطلب 1042 جاهز.</p></div>');
    expect(html("")).toBe('<div class="md-body"></div>');
  });
});
