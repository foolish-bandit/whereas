/* eslint-env node */
"use strict";

/**
 * Bans raw Tailwind color-palette literals in JSX className strings.
 *
 * Whereas uses semantic design tokens (bg-danger-soft, text-success,
 * border-info-ring …) sourced from tailwind.config.js so the palette
 * can shift without sweeping every component. Inline literals like
 * bg-rose-50 or text-emerald-900 bypass that system and create
 * regressions whenever the palette evolves.
 *
 * The rule walks JSX attributes named `className` and template-literal
 * className expressions, and flags any class token matching:
 *   (bg|text|border|ring|fill|stroke)-(rose|red|emerald|green|amber|
 *      yellow|blue|sky|slate|gray|zinc|neutral)-(0|50|100|…|950)
 *
 * Files inside `src/lib/chartPalette.ts` are exempt — Recharts needs
 * raw hex values and the palette is the single allowlisted source.
 */

const BANNED_HUES = [
  "rose",
  "red",
  "emerald",
  "green",
  "amber",
  "yellow",
  "blue",
  "sky",
  "slate",
  "gray",
  "zinc",
  "neutral",
];

const BANNED_PROPS = ["bg", "text", "border", "ring", "fill", "stroke"];

// One conservative regex applied to every class token. `[/-]` covers
// arbitrary-value modifiers (bg-rose-50/40, text-red-700/80).
const BANNED_REGEX = new RegExp(
  String.raw`\b(?:${BANNED_PROPS.join("|")})-(?:${BANNED_HUES.join(
    "|",
  )})-\d{2,3}\b`,
);

function tokenize(classString) {
  return classString.split(/\s+/).filter(Boolean);
}

function reportIfBanned(context, node, raw) {
  const hits = tokenize(raw).filter((t) => BANNED_REGEX.test(t));
  if (hits.length === 0) return;
  context.report({
    node,
    messageId: "banned",
    data: {
      tokens: Array.from(new Set(hits)).join(", "),
    },
  });
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Tailwind palette literals (bg-rose-50 etc.); use design tokens — see docs/design-tokens.md.",
    },
    schema: [],
    messages: {
      banned:
        "Raw Tailwind palette class(es) found: {{tokens}}. Use semantic design tokens instead. See docs/design-tokens.md.",
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (
      filename.includes("/lib/chartPalette.") ||
      filename.endsWith("/chartPalette.ts")
    ) {
      return {};
    }
    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== "className") return;
        const value = node.value;
        if (!value) return;
        if (value.type === "Literal" && typeof value.value === "string") {
          reportIfBanned(context, value, value.value);
        }
        if (value.type === "JSXExpressionContainer") {
          walkExpression(context, value.expression);
        }
      },
    };
  },
};

function walkExpression(context, node) {
  if (!node) return;
  if (node.type === "Literal" && typeof node.value === "string") {
    reportIfBanned(context, node, node.value);
    return;
  }
  if (node.type === "TemplateLiteral") {
    for (const q of node.quasis) {
      reportIfBanned(context, q, q.value.cooked || "");
    }
    for (const e of node.expressions) walkExpression(context, e);
    return;
  }
  if (node.type === "ConditionalExpression") {
    walkExpression(context, node.consequent);
    walkExpression(context, node.alternate);
    return;
  }
  if (node.type === "LogicalExpression" || node.type === "BinaryExpression") {
    walkExpression(context, node.left);
    walkExpression(context, node.right);
    return;
  }
  if (node.type === "ArrayExpression") {
    for (const el of node.elements) walkExpression(context, el);
    return;
  }
}
