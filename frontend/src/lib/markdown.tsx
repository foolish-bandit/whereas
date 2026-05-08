/**
 * Minimal, safe Markdown → React renderer for the Markdown working
 * snapshot preview in the contract workspace.
 *
 * Why hand-rolled instead of a library:
 * - The frontend has no markdown dependency yet, and pulling one in
 *   for a single read-only preview is overkill.
 * - This renderer NEVER uses ``dangerouslySetInnerHTML``. Every node
 *   is a typed React element, so an attacker who somehow controls the
 *   markdown string cannot inject arbitrary HTML/scripts.
 *
 * Supported subset (intentionally small):
 *   Block:  ATX headings (#..######), paragraphs, blockquotes (``>``),
 *           unordered lists (``-``/``*``), ordered lists (``1.``),
 *           horizontal rules (``---``/``***``/``___``), fenced code
 *           blocks (```` ``` ```` … ```` ``` ````).
 *   Inline: ``**bold**``, ``*italic*``, ``` `code` ```,
 *           ``[text](url)``. Text-only fallback for everything else.
 *
 * Anything outside that subset is rendered as plain text — there is
 * no raw-HTML escape hatch by design.
 */
import type { ReactNode } from "react";

const SAFE_URL_SCHEMES = ["http://", "https://", "mailto:"];

interface BlockListItem {
  text: string;
  ordinal?: number;
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "ul"; items: BlockListItem[] }
  | { kind: "ol"; items: BlockListItem[] }
  | { kind: "hr" }
  | { kind: "code"; lang: string | null; text: string };

export function renderMarkdown(source: string): ReactNode {
  const blocks = parseBlocks(source);
  return blocks.map((block, i) => renderBlock(block, i));
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];

  // Buffers for blocks that span multiple lines.
  let paragraph: string[] | null = null;
  let blockquote: string[] | null = null;
  let ulItems: BlockListItem[] | null = null;
  let olItems: BlockListItem[] | null = null;

  function flushParagraph() {
    if (paragraph && paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    }
    paragraph = null;
  }
  function flushBlockquote() {
    if (blockquote && blockquote.length > 0) {
      blocks.push({ kind: "blockquote", text: blockquote.join(" ") });
    }
    blockquote = null;
  }
  function flushLists() {
    if (ulItems && ulItems.length > 0) {
      blocks.push({ kind: "ul", items: ulItems });
    }
    ulItems = null;
    if (olItems && olItems.length > 0) {
      blocks.push({ kind: "ol", items: olItems });
    }
    olItems = null;
  }
  function flushAll() {
    flushParagraph();
    flushBlockquote();
    flushLists();
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    // Fenced code: greedy take to the closing ``` line.
    const fence = /^```(\s*([A-Za-z0-9_-]+))?\s*$/.exec(line);
    if (fence) {
      flushAll();
      const lang = fence[2] ?? null;
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "code", lang, text: buf.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    if (/^(\s*)([-*_])(\s*\2){2,}\s*$/.test(line)) {
      flushAll();
      blocks.push({ kind: "hr" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*\S)\s*#*\s*$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2],
      });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushLists();
      if (blockquote == null) blockquote = [];
      blockquote.push(quote[1]);
      continue;
    }

    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ul) {
      flushParagraph();
      flushBlockquote();
      if (olItems) {
        flushLists();
      }
      if (ulItems == null) ulItems = [];
      ulItems.push({ text: ul[1] });
      continue;
    }

    const ol = /^\s*(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      flushParagraph();
      flushBlockquote();
      if (ulItems) {
        flushLists();
      }
      if (olItems == null) olItems = [];
      olItems.push({ text: ol[2], ordinal: parseInt(ol[1], 10) });
      continue;
    }

    // Continuation of an open list item (indented wrap).
    if (
      (ulItems && ulItems.length > 0 && /^\s+/.test(raw)) ||
      (olItems && olItems.length > 0 && /^\s+/.test(raw))
    ) {
      const list = ulItems ?? olItems!;
      list[list.length - 1].text += " " + line.trim();
      continue;
    }

    // Plain paragraph line.
    flushBlockquote();
    flushLists();
    if (paragraph == null) paragraph = [];
    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const cls = headingClass(block.level);
      const Tag = `h${block.level}` as keyof JSX.IntrinsicElements;
      return (
        <Tag key={key} className={cls}>
          {renderInline(block.text)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="mt-3 text-[15px] leading-relaxed text-ink">
          {renderInline(block.text)}
        </p>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="mt-3 border-l-2 border-rule-strong pl-3 text-[15px] italic leading-relaxed text-ink-muted"
        >
          {renderInline(block.text)}
        </blockquote>
      );
    case "ul":
      return (
        <ul
          key={key}
          className="mt-3 list-disc space-y-1 pl-6 text-[15px] leading-relaxed text-ink"
        >
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item.text)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol
          key={key}
          className="mt-3 list-decimal space-y-1 pl-6 text-[15px] leading-relaxed text-ink"
        >
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item.text)}</li>
          ))}
        </ol>
      );
    case "hr":
      return <hr key={key} className="my-4 border-rule" />;
    case "code":
      return (
        <pre
          key={key}
          className="mt-3 overflow-x-auto rounded border border-rule bg-canvas-subtle p-3 font-mono text-[13px] leading-relaxed text-ink"
        >
          <code>{block.text}</code>
        </pre>
      );
  }
}

function headingClass(level: 1 | 2 | 3 | 4 | 5 | 6): string {
  switch (level) {
    case 1:
      return "mt-4 font-serif text-2xl text-ink first:mt-0";
    case 2:
      return "mt-5 font-serif text-xl text-ink first:mt-0";
    case 3:
      return "mt-4 font-serif text-lg text-ink first:mt-0";
    default:
      return "mt-4 font-serif text-base font-medium text-ink first:mt-0";
  }
}

// --------------------------------------------------------------------------
// Inline rendering
// --------------------------------------------------------------------------

interface InlineToken {
  kind: "text" | "code" | "bold" | "italic" | "link";
  text: string;
  href?: string;
}

export function renderInline(text: string): ReactNode[] {
  return tokenizeInline(text).map((tok, i) => {
    switch (tok.kind) {
      case "text":
        return <span key={i}>{tok.text}</span>;
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-canvas-subtle px-1 py-0.5 font-mono text-[13px] text-ink"
          >
            {tok.text}
          </code>
        );
      case "bold":
        return (
          <strong key={i} className="font-semibold text-ink">
            {tok.text}
          </strong>
        );
      case "italic":
        return (
          <em key={i} className="italic">
            {tok.text}
          </em>
        );
      case "link": {
        const href = safeHref(tok.href ?? "");
        if (!href) {
          return <span key={i}>{tok.text}</span>;
        }
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-ring underline hover:text-ink"
          >
            {tok.text}
          </a>
        );
      }
    }
  });
}

function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let buf = "";

  function flushBuf() {
    if (buf.length > 0) {
      tokens.push({ kind: "text", text: buf });
      buf = "";
    }
  }

  while (i < input.length) {
    const ch = input[i];

    // Inline code: `...`
    if (ch === "`") {
      const close = input.indexOf("`", i + 1);
      if (close > i) {
        flushBuf();
        tokens.push({ kind: "code", text: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    // Bold: **...**
    if (ch === "*" && input[i + 1] === "*") {
      const close = input.indexOf("**", i + 2);
      if (close > i + 1) {
        flushBuf();
        tokens.push({ kind: "bold", text: input.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }

    // Italic: *...* (single-asterisk; only when bold didn't match)
    if (ch === "*") {
      const close = input.indexOf("*", i + 1);
      if (close > i && input[i + 1] !== " ") {
        flushBuf();
        tokens.push({ kind: "italic", text: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    // Link: [text](url)
    if (ch === "[") {
      const closeBracket = input.indexOf("]", i + 1);
      if (closeBracket > i && input[closeBracket + 1] === "(") {
        const closeParen = input.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 1) {
          flushBuf();
          tokens.push({
            kind: "link",
            text: input.slice(i + 1, closeBracket),
            href: input.slice(closeBracket + 2, closeParen).trim(),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }
  flushBuf();
  return tokens;
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  // Absolute URLs only on an explicit allowlist (no javascript:, data:,
  // file:, etc.).
  if (SAFE_URL_SCHEMES.some((p) => lower.startsWith(p))) {
    return trimmed;
  }
  // Anything that LOOKS like a scheme but isn't on the allowlist is
  // rejected. Relative paths, fragments, and bare names are allowed.
  if (/^[a-z][a-z0-9+.-]*:/i.test(lower)) {
    return null;
  }
  return trimmed;
}
