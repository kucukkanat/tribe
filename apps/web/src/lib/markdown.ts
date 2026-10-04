import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

// Links open in a new tab without leaking window.opener or the referrer (which may
// contain the bucket id in the hash route).
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(src: string): string {
  const html = (marked.parse(src, { async: false }) as string)
    // <input> is forbidden below; keep GFM task lists readable as glyphs.
    .replace(/<input\b[^>]*\bchecked\b[^>]*>/g, "\u2611\uFE0E ")
    .replace(/<input\b[^>]*type="checkbox"[^>]*>/g, "\u2610\uFE0E ");
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input"],
    FORBID_ATTR: ["style"],
  });
}

/** Plain-text excerpt for cards. */
export function excerpt(src: string, max = 180): string {
  const t = src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?[-:| ]+\|[-:| ]*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, "")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Drop a leading "# Title" line when it repeats the entry title. */
export function stripTitle(src: string, title: string): string {
  const m = /^\s*#\s+(.+)\n?/.exec(src);
  return m && m[1]!.trim().toLowerCase() === title.trim().toLowerCase() ? src.slice(m[0].length) : src;
}
