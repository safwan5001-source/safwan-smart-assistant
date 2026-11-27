"use client";
/**
 * A BASHT reply rendered as Markdown (GFM): headings, emphasis, lists, quotes, links, tables, code. Used for engine replies, the
 * live (streaming) reply and assistant messages kept on this device. The owner's own messages stay plain text.
 *
 * Safety: raw HTML in a reply is never executed — react-markdown shows it as text (no rehype-raw); links are only
 * http(s)/mailto/tel and open in a new tab without an opener; remote images are never loaded (they become a link). See lib/markdown.
 * Bidi: every block decides its own direction (dir="auto"); code is always LTR. Copying the whole message still copies the raw text
 * (the bubble's own copy button); each code block has its own copy button.
 * Streaming: partial text is safe to render — an unclosed ``` simply shows as a code block until it closes.
 * Perf: memoized by text, so a bubble is only re-parsed when its text changes (a streaming reply), never on a keystroke or a poll;
 * a reply with no Markdown syntax at all skips the parser. Single line breaks inside a paragraph are kept (CSS pre-line), as before.
 */
import { createElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import Icon from "@/components/icon";
import { codeLanguage, isAppPath, isPlainText, markdownUrl, safeHref, textDirection } from "@/lib/markdown";

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };
const textOf = (n: HastNode | undefined): string => (!n ? "" : n.type === "text" ? n.value ?? "" : (n.children ?? []).map(textOf).join(""));

function CodeBlock({ node }: ExtraProps) {
  const code = (node as HastNode | undefined)?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const cls = code?.properties?.className;
  const lang = codeLanguage(Array.isArray(cls) ? cls.join(" ") : cls);
  const text = textOf(code).replace(/\n$/, "");
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    let ok = true;
    try { await navigator.clipboard.writeText(text); } catch { ok = false; }
    setCopied(ok ? "ok" : "fail");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(""), 1800);
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <bdi className="md-code-lang">{lang || "كود"}</bdi>
        <button type="button" className="md-code-copy" onClick={() => void copy()} aria-label={copied === "ok" ? "تم نسخ الكود" : "نسخ الكود"}>
          <Icon name={copied === "ok" ? "check" : "copy"} size={16} />
          <span aria-hidden="true">{copied === "ok" ? "تم النسخ" : copied === "fail" ? "تعذّر النسخ" : "نسخ"}</span>
        </button>
      </div>
      <pre dir="ltr" tabIndex={0}><code>{text}</code></pre>
      <span className="sr-only" role="status">{copied === "ok" ? "تم نسخ الكود" : copied === "fail" ? "تعذّر النسخ. حدّد الكود وانسخه يدويًا." : ""}</span>
    </div>
  );
}

/** Headings inside a message sit below the page's own h1/h2: # → h3 … #### and deeper → h6. */
const heading = (level: number) => function MdHeading({ node: _n, children }: { children?: ReactNode } & ExtraProps) {
  return createElement(`h${Math.min(6, level + 2)}`, { dir: "auto", className: "md-h" + Math.min(level, 4) }, children);
};

const components: Components = {
  h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6),
  p: ({ node: _n, ...p }) => <p dir="auto" {...p} />,
  // containers take the direction of their first letter (see textDirection); cells follow their table, so a column stays aligned
  li: ({ node, ...p }) => <li dir={textDirection(textOf(node as HastNode))} {...p} />,
  blockquote: ({ node, ...p }) => <blockquote dir={textDirection(textOf(node as HastNode))} {...p} />,
  table: ({ node, ...p }) => (
    <div className="md-table" role="region" aria-label="جدول" tabIndex={0} dir={textDirection(textOf(node as HastNode))}><table {...p} /></div>
  ),
  pre: CodeBlock,
  code: ({ node: _n, ...p }) => <code dir="ltr" {...p} />,
  a: ({ node: _n, href, children, title }) => {
    const h = safeHref(href);
    return h ? <a href={h} title={title} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
  img: ({ node: _n, src, alt }) => {
    const label = alt?.trim() || "صورة";
    if (typeof src === "string" && isAppPath(src)) {
      // eslint-disable-next-line @next/next/no-img-element -- an app-served file inside a message; next/image adds nothing here
      return <img className="md-img" src={src} alt={label} loading="lazy" decoding="async" />;
    }
    const h = typeof src === "string" ? safeHref(src) : null;
    return h
      ? <a className="md-img-link" href={h} target="_blank" rel="noopener noreferrer"><Icon name="image" size={16} />{label}</a>
      : <span>{label}</span>;
  },
};

const remarkPlugins = [remarkGfm];

function MessageBodyImpl({ text }: { text: string }) {
  // plain prose (no Markdown syntax at all) needs no parser: the same paragraphs, without its cost
  const plain = isPlainText(text) ? text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean) : null;
  return (
    <div className="md-body">
      {plain ? plain.map((p, i) => <p key={i} dir="auto">{p}</p>)
        : <Markdown remarkPlugins={remarkPlugins} components={components} urlTransform={markdownUrl}>{text}</Markdown>}
    </div>
  );
}

const MessageBody = memo(MessageBodyImpl);
export default MessageBody;
