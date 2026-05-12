# UI/UX Simplification Audit (Dropdowns, Autofill, Consolidation, Icons)

Date: 2026-05-12
Scope: Frontend application surfaces under `frontend/src`.

## Executive summary

The app is visually clean, but several workflows still ask users to manually type repeated values, interpret dense cards, or navigate multiple adjacent pages that feel like slices of one task. The biggest simplification wins are:

1. Convert repeated free-text fields to controlled selects/comboboxes with suggestions.
2. Collapse “related but separated” pages into task-oriented tabs and progressive disclosure panels.
3. Add a consistent icon language (shadcn/lucide) to distinguish actions, status, and object types at scan speed.
4. Reduce per-row noise in dense lists (Requests and Repository) by defaulting secondary details to expandable regions.

---

## 1) Where to add dropdowns/autofill/suggestions

## A. Request creation form (highest impact)
Files: `frontend/src/pages/RequestsPage.tsx`

Current friction:
- `counterparty` and `contractType` are manual text fields and likely repeated values.
- `requestType` / `priority` are finite enums but are often rendered with little assistive context.
- Due date can be set without guidance about urgency and workload.

Recommendations:
- Replace `counterparty` input with **combobox + typeahead suggestions** from historical counterparties.
  - Show “recent counterparties” on focus.
  - Allow free-entry fallback for new names.
- Replace `contractType` input with **combobox with canonical templates** (e.g., NDA, MSA, SOW, DPA) + free-entry fallback.
- Keep `requestType` and `priority` as **explicit dropdowns** with helper descriptions in option text.
- Add **due date quick-picks** near date picker: “+3 days”, “+1 week”, “End of month”.
- Autofill `title` using pattern: `{{counterparty}} {{contractType}}` once both fields selected; keep editable.

Expected outcome:
- Faster intake creation, less taxonomy drift, improved downstream filtering and policy matching.

## B. Repository filters in Contracts page
Files: `frontend/src/pages/ContractsPage.tsx`

Current friction:
- Several filters are exposed simultaneously (status/type/sort/merged/search), which can feel busy.
- “Advanced filters” are default-expanded, increasing initial noise.

Recommendations:
- Convert to a **single “Filter” popover** with grouped controls:
  - Status (single-select)
  - Document type (multi-select chips)
  - Include merged (toggle)
  - Sort (dropdown)
- Default advanced panel to **collapsed** and show a compact “N filters active” indicator.
- Persist last filter preset per user (localStorage at minimum) and offer “Saved views” dropdown.

Expected outcome:
- Cleaner first impression without losing power.

## C. Settings development user ID
Files: `frontend/src/pages/SettingsPage.tsx`

Current friction:
- UUID input is high-friction and error-prone, and user must know DB internals.

Recommendations:
- Add “Use recent dev user IDs” dropdown (local cache) + paste validation.
- Add “Fetch seeded users” button in non-demo environments to replace manual DB lookup.
- Provide inline format guidance with input masking/validation hint while typing.

Expected outcome:
- Faster setup and fewer blocked first-run moments.

## D. Artifact compare selection in workspace
Files: `frontend/src/pages/ContractWorkspacePage.tsx`

Current friction:
- Version compare depends on choosing two artifacts; this can become cognitive overhead.

Recommendations:
- Use two labeled dropdowns with smart defaults:
  - Base: latest executed/uploaded artifact
  - Compare: immediately previous artifact
- Add one-click presets:
  - “Current vs Previous”
  - “Original vs Current”

Expected outcome:
- Fewer clicks and clearer compare intent.

---

## 2) Where to consolidate/simplify page structure

## A. Requests + request detail + template flows
Files: `frontend/src/pages/RequestsPage.tsx`, `frontend/src/pages/RequestDetailPage.tsx`, `frontend/src/pages/AgreementTemplatesPage.tsx`

Current friction:
- Multiple surfaces mix intake, conversion, approval status, timeline, and templates, creating workflow fragmentation.

Recommendations:
- Introduce a **Requests workspace with tabs**:
  - `Intake Queue`
  - `Templates`
  - `Completed/Archive`
- On each request row, move secondary areas (timeline/export/approval details) behind “Details” accordion.
- Keep primary row actions only: “Open”, “Mark in progress/completed”, “Convert”.

Expected outcome:
- Reduced list noise, clearer operational workflow.

## B. Approvals pages
Files: `frontend/src/pages/ApprovalsLandingPage.tsx`, `ApprovalTasksPage.tsx`, `ApprovalWorkflowsPage.tsx`, `ApprovalWorkflowTemplatesPage.tsx`, `ApprovalPoliciesPage.tsx`

Current friction:
- Many approvals sub-pages are conceptually one system; users may not know where to start.

Recommendations:
- Keep landing cards, but add **single Approvals hub** with segmented tabs:
  - Tasks | Workflows | Templates | Policies
- Preserve routes for deep links, but unify day-to-day usage into one page shell.
- Add contextual “What this is / when to use” microcopy above each tab table.

Expected outcome:
- Less navigation churn and better mental model.

## C. Contract workspace right panel
Files: `frontend/src/pages/ContractWorkspacePage.tsx`, `frontend/src/components/RightPanelTabs.tsx`

Current friction:
- Metadata / Clauses / Review + artifact workflows + timeline can feel like too many concurrent modes.

Recommendations:
- Split into two-tier information architecture:
  - Tier 1 tabs: `Read` | `Negotiate` | `History`
  - Tier 2 contextual panels within each tier.
- Move rarely used controls (export/save compare variants) into overflow menus.

Expected outcome:
- Reduced mode confusion and cleaner default reading experience.

---

## 3) Icon system recommendations (shadcn/lucide)

Adopt a shared `IconLabel` pattern for nav items, cards, filter chips, row actions, and status chips.

Suggested mappings:
- Dashboard: `LayoutDashboard`
- Repository: `FolderKanban` or `Archive`
- Requests: `FilePlus2`
- Playbooks: `BookMarked`
- Clause Manager: `Scale`
- Approvals: `ShieldCheck`
- Settings: `Settings`

Action icons:
- Create/New: `Plus`
- Convert: `RefreshCcw` or `FileCog`
- Upload: `Upload`
- Download: `Download`
- Compare: `GitCompare`
- Timeline/Activity: `History`
- Export: `FileDown`

Status iconography:
- Ready/Complete: `CheckCircle2`
- In progress/extracting: `Loader2`
- Warning/needs attention: `TriangleAlert`
- Failed: `CircleX`
- Overdue: `Clock3`

Guidelines:
- Always pair icon + text label (no icon-only critical actions).
- Keep size/color consistent by semantic role (navigation, status, inline action).
- Avoid mixing too many icon metaphors for similar actions.

---

## 4) Noise-reduction checklist (quick wins)

1. Default-collapse secondary sections in long list rows (Requests, Repository).
2. Reduce helper text repetition; move long explanations into tooltips/learn-more popovers.
3. Promote top 1–2 primary actions, tuck the rest into “More” menu.
4. Normalize button styles and action placement across pages.
5. Add empty-state action shortcuts (e.g., “Create request”, “Import template”).

---

## 5) Priority rollout plan

### Phase 1 (1–2 sprints, highest ROI)
- Request form comboboxes + due-date quick picks.
- Repository filter popover + collapsed advanced filters by default.
- Sidebar + approvals cards icon pass.

### Phase 2 (2–3 sprints)
- Requests workspace consolidation (tabs + row detail accordion).
- Approvals hub consolidation with preserved deep links.
- Contract compare default selections and preset actions.

### Phase 3 (later)
- Personal saved views and autofill model improvements.
- Cross-workspace design token hardening for action hierarchy.

---

## 6) Success metrics

Track before/after:
- Time to create request.
- Request form abandonment/error rate.
- Avg. clicks to find/act on pending approval task.
- Repository filter usage and reset frequency.
- Contract workspace compare completion rate.

