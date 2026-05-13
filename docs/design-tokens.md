# Design tokens

Whereas uses **semantic** Tailwind classes — never raw palette
literals. The token names live in `frontend/tailwind.config.js`; this
doc is the contributor-facing index. The ESLint rule
`no-raw-palette` enforces the boundary by failing CI when something
like `bg-rose-50` lands in a JSX `className`.

## Why

A semantic token (`bg-danger-soft`) survives a palette refresh. A
raw literal (`bg-rose-50`) doesn't — every place it appears has to
be hunted down and migrated. Two existing examples that motivated
the rule:

- The contract workspace's compare-line renderer used
  `bg-rose-50 / text-rose-900 / bg-emerald-50 / text-emerald-900`
  for the diff sides; one palette refresh would have left every diff
  off-brand. (Migrated to `bg-danger-soft` / `bg-success-soft`.)
- The dashboard's "Needs attention" alert had been keying off
  `bg-rose-50` rather than `bg-danger-soft`.

## Allowed semantic groups

| Concept | Soft (background) | Strong (text / fill) | Ring / border |
|---|---|---|---|
| `success` | `bg-success-soft` | `text-success` | `border-success-ring` |
| `info` | `bg-info-soft` | `text-info` | `border-info-ring` |
| `warning` | `bg-warning-soft` | `text-warning` | `border-warning-ring` |
| `danger` | `bg-danger-soft` | `text-danger` | `border-danger-ring` |
| `accent` | — | `text-accent` | `border-accent-ring` |
| `ink` / `canvas` | `bg-canvas`, `bg-canvas-subtle`, `bg-canvas-muted` | `text-ink`, `text-ink-muted`, `text-ink-subtle` | `border-rule`, `border-rule-strong` |

These are the only color tokens components should reach for.

## Examples

```tsx
// Right
<div className="rounded border border-danger-ring bg-danger-soft p-3 text-danger">
  …
</div>

// Wrong — banned by `no-raw-palette`
<div className="rounded border border-rose-200 bg-rose-50 p-3 text-rose-900">
  …
</div>
```

## What is banned

The `no-raw-palette` rule matches any class of the form
`<prop>-<hue>-<weight>` where:

- `prop` ∈ `bg`, `text`, `border`, `ring`, `fill`, `stroke`
- `hue` ∈ `rose`, `red`, `emerald`, `green`, `amber`, `yellow`,
  `blue`, `sky`, `slate`, `gray`, `zinc`, `neutral`
- `weight` is any 2- or 3-digit number (`50`, `200`, `900`, …)

The rule looks at JSX `className` attributes — string literals,
template literals, ternaries, logical expressions, and arrays — and
flags every offending token.

## Allowlisted callers

One file is exempt: **`frontend/src/lib/chartPalette.ts`**. Recharts
needs raw hex values for its `Cell` fills and the like, and the
palette helper is the single allowlisted source. New chart colors go
in that file; never inline.

## Adding a new token

When a new semantic concept appears (e.g. a future `caution` tone),
add the variants to `frontend/tailwind.config.js`'s `theme.extend.colors`
map alongside the existing tokens. Once the names exist, components
can use them without further config.

## Running the rule locally

```bash
cd frontend && npm run lint
```

The rule loads via `eslint --rulesdir eslint-rules`; see
`frontend/eslint-rules/no-raw-palette.js`.
