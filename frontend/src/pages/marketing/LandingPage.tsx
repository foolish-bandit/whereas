/**
 * Marketing landing page.
 *
 * Mirrors the actual app surface: each section names a workspace the
 * visitor can click straight into (Repository / Requests / Templates /
 * Approvals / Document History) and the inline preview cards reuse
 * the same StatusBadge component and chip styling the app renders.
 *
 * Copy carefully avoids implying that Whereas provides legal advice —
 * it surfaces information about contracts, with span citations back
 * to source. That phrasing is repeated by design (see CLAUDE.md).
 */
import { Link } from "react-router-dom";

import StatusBadge from "../../components/StatusBadge";

import MarketingFooter from "./MarketingFooter";
import MarketingHeader from "./MarketingHeader";

const GITHUB_URL = "https://github.com/foolish-bandit/whereas";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas-subtle">
      <MarketingHeader />
      <main className="flex-1">
        <Hero />
        <WorkflowStrip />
        <SurfacePreviews />
        <AudienceSplit />
        <FeatureGrid />
        <SpanCitationsSection />
        <SelfHostSection />
        <HonestStatusSection />
        <CTASection />
      </main>
      <MarketingFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-10 lg:py-24">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-ink-subtle">
          Open-source · Self-hostable · AGPL-3.0
        </p>
        <h1 className="mt-3 max-w-3xl font-serif text-3xl leading-tight text-ink sm:text-5xl sm:leading-tight">
          A contract repository that stays on{" "}
          <span className="text-accent">your</span> infrastructure.
        </h1>
        <p className="mt-5 max-w-2xl text-base text-ink-muted sm:text-lg">
          Whereas is a post-execution contract workspace for small and
          mid-sized legal teams. Request intake, template-driven
          generation, approval workflows, embedded e-signature via
          DocuSeal, span-cited extraction, and full document history —
          all running on a single machine, behind your firewall.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Link
            to="/demo"
            className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-5 py-3 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto"
          >
            Try the live demo
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-full items-center justify-center rounded border border-rule bg-canvas px-5 py-3 text-sm font-medium text-ink hover:border-rule-strong sm:w-auto"
          >
            View source on GitHub
          </a>
        </div>
        <p className="mt-6 max-w-2xl text-xs text-ink-subtle">
          Pre-v0.1. Whereas surfaces information about contracts; it does not
          provide legal advice and does not replace human legal review.
        </p>
      </div>
    </section>
  );
}

/**
 * Visualizes the end-to-end CLM loop the app actually wires up:
 * request → template → repository → approval → DocuSeal → executed.
 * Each step is a workspace in the demo; the label clicks straight in.
 */
const WORKFLOW_STEPS: Array<{
  step: string;
  surface: string;
  to: string;
  body: string;
}> = [
  {
    step: "01",
    surface: "Requests",
    to: "/demo/requests",
    body:
      "Capture incoming contract requests with type, counterparty, " +
      "and due date. Track open / in progress / completed in one " +
      "queue.",
  },
  {
    step: "02",
    surface: "Templates",
    to: "/demo/requests/templates",
    body:
      "Upload your firm's NDA / MSA / SOW templates once. Variable " +
      "detection scans for `{{placeholders}}`; generation produces a " +
      "draft contract on demand.",
  },
  {
    step: "03",
    surface: "Repository",
    to: "/demo/repository",
    body:
      "Every uploaded and generated contract lands here with extracted " +
      "metadata, clauses, and the Text-preview body. Search by title " +
      "or content; filter by lifecycle state.",
  },
  {
    step: "04",
    surface: "Approvals",
    to: "/demo/approvals",
    body:
      "Author per-contract-type approval workflows. Block " +
      "sent-for-signature until every required step is approved. " +
      "Cancel runs cleanly with a two-step confirm.",
  },
  {
    step: "05",
    surface: "DocuSeal",
    to: "/demo/repository",
    body:
      "Send the generated DOCX to DocuSeal for signature. On the " +
      "completion webhook, Whereas materializes a `signed_pdf` " +
      "artifact and flips the contract status to executed.",
  },
  {
    step: "06",
    surface: "History",
    to: "/demo/repository",
    body:
      "Every artifact stays in Document History — original upload, " +
      "generated DOCX, signed PDF, saved redlines. Download, preview, " +
      "compare versions, restore a prior source.",
  },
];

function WorkflowStrip() {
  return (
    <section className="border-y border-rule bg-canvas-subtle">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16 lg:px-10">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-ink-subtle">
          The end-to-end CLM loop
        </p>
        <h2 className="mt-3 max-w-2xl font-serif text-2xl text-ink sm:text-3xl">
          From request to executed signature — without leaving your stack.
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-ink-muted">
          Each step below is a workspace in the live demo. Click a
          surface name to jump straight in.
        </p>
        <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {WORKFLOW_STEPS.map((s) => (
            <li
              key={s.step}
              className="flex flex-col rounded-lg border border-rule bg-canvas p-5"
            >
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-ink-subtle">
                  {s.step}
                </span>
                <Link
                  to={s.to}
                  className="text-sm font-medium text-ink hover:text-accent"
                >
                  {s.surface}
                  <span aria-hidden> →</span>
                </Link>
              </div>
              <p className="mt-2 text-sm text-ink-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * Three inline mockups using the actual app's StatusBadge component
 * and chip styling so visitors recognize what they're about to see
 * in the demo. None of this is interactive; the StatusBadge import
 * is the same primitive Repository / Document History render today.
 */
function SurfacePreviews() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16 lg:px-10">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-ink-subtle">
          What the surfaces look like
        </p>
        <h2 className="mt-3 max-w-2xl font-serif text-2xl text-ink sm:text-3xl">
          Same UI live and self-hosted.
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-ink-muted">
          The demo and a real Whereas deployment render from the same
          codebase. The previews below use the actual app components.
        </p>
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <RepositoryPreviewCard />
          <ApprovalPreviewCard />
          <ArtifactHistoryPreviewCard />
        </div>
      </div>
    </section>
  );
}

function RepositoryPreviewCard() {
  return (
    <article className="flex flex-col rounded-lg border border-rule bg-canvas-subtle p-5">
      <header>
        <p className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
          Repository
        </p>
        <h3 className="mt-1 text-sm font-medium text-ink">
          Search + filter + match hints
        </h3>
      </header>
      <div className="mt-4 space-y-2">
        <RepositoryRowPreview
          title="Mutual NDA — Acme &amp; Globex"
          status="executed"
          match="title_and_text_preview"
        />
        <RepositoryRowPreview
          title="Cloud SaaS Subscription — Lyra Cloud"
          status="sent_for_signature"
          match="title"
        />
        <RepositoryRowPreview
          title="Vendor SOW — Hooli"
          status="failed"
          match={null}
        />
      </div>
      <p className="mt-4 text-xs text-ink-subtle">
        Quick views (<em>Drafts</em>, <em>Out for signature</em>,{" "}
        <em>Executed</em>) + advanced filters + merged-duplicate
        toggle.
      </p>
    </article>
  );
}

function RepositoryRowPreview({
  title,
  status,
  match,
}: {
  title: string;
  status: string;
  match: "title" | "text_preview" | "title_and_text_preview" | null;
}) {
  const matchLabel = match
    ? match === "title"
      ? "Matched title"
      : match === "text_preview"
        ? "Matched Text preview"
        : "Matched title + Text preview"
    : null;
  return (
    <div className="flex flex-col gap-2 rounded border border-rule bg-canvas px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-ink">{title}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {matchLabel && (
          <span className="rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info">
            {matchLabel}
          </span>
        )}
        <StatusBadge status={status} />
      </div>
    </div>
  );
}

function ApprovalPreviewCard() {
  return (
    <article className="flex flex-col rounded-lg border border-rule bg-canvas-subtle p-5">
      <header>
        <p className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
          Approvals
        </p>
        <h3 className="mt-1 text-sm font-medium text-ink">
          Workflow timeline
        </h3>
      </header>
      <ol className="mt-4 space-y-3">
        <ApprovalStepPreview
          order={1}
          title="Legal review"
          status="approved"
        />
        <ApprovalStepPreview
          order={2}
          title="Finance approval"
          status="current"
        />
        <ApprovalStepPreview
          order={3}
          title="VP sign-off"
          status="pending"
        />
      </ol>
      <p className="mt-4 text-xs text-ink-subtle">
        Approve / reject inline. Two-step cancel. DocuSeal send blocked
        until every required step is approved.
      </p>
    </article>
  );
}

function ApprovalStepPreview({
  order,
  title,
  status,
}: {
  order: number;
  title: string;
  status: "approved" | "current" | "pending";
}) {
  const dotClasses =
    status === "approved"
      ? "bg-success"
      : status === "current"
        ? "border border-info bg-info/20"
        : "border border-rule bg-canvas";
  const labelClasses =
    status === "approved"
      ? "text-success"
      : status === "current"
        ? "text-info"
        : "text-ink-subtle";
  const label =
    status === "approved"
      ? "Approved"
      : status === "current"
        ? "Pending you"
        : "Pending";
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={`mt-1 h-3 w-3 shrink-0 rounded-full ${dotClasses}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-ink-subtle">Step {order}</p>
        <p className="text-sm text-ink">{title}</p>
        <p className={`text-[10px] font-medium uppercase tracking-wide ${labelClasses}`}>
          {label}
        </p>
      </div>
    </li>
  );
}

function ArtifactHistoryPreviewCard() {
  return (
    <article className="flex flex-col rounded-lg border border-rule bg-canvas-subtle p-5">
      <header>
        <p className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
          Document History
        </p>
        <h3 className="mt-1 text-sm font-medium text-ink">
          Every artifact, in one place
        </h3>
      </header>
      <ol className="mt-4 space-y-2">
        <ArtifactRowPreview
          label="Signed PDF"
          source="docuseal · signed_at 2026-03-18"
          tag="Current"
        />
        <ArtifactRowPreview
          label="Generated Word document"
          source="template_generation · Mutual NDA"
        />
        <ArtifactRowPreview
          label="Source file"
          source="user_upload"
        />
        <ArtifactRowPreview
          label="Redline"
          source="compare_export · +3 / −2"
        />
      </ol>
      <p className="mt-4 text-xs text-ink-subtle">
        Download, inline preview, version-to-version compare,
        paragraph-aware redline export.
      </p>
    </article>
  );
}

function ArtifactRowPreview({
  label,
  source,
  tag,
}: {
  label: string;
  source: string;
  tag?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded border border-rule bg-canvas px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{label}</p>
        <p className="truncate text-[11px] text-ink-subtle">{source}</p>
      </div>
      {tag && (
        <span className="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
          {tag}
        </span>
      )}
    </li>
  );
}

function AudienceSplit() {
  return (
    <section className="border-y border-rule bg-canvas-subtle">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16 lg:px-10">
        <h2 className="font-serif text-2xl text-ink sm:text-3xl">
          Two audiences, one tool
        </h2>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <AudienceCard
            tag="For legal teams"
            title="Find what the contract actually says — with the citation."
            bullets={[
              "Every extracted field, clause, and finding links back to the exact span in the source document.",
              "Approval workflows gate signature; nothing ships to DocuSeal until your firm's required reviews are green.",
              "Search the whole repository by title or by Text-preview body, with quick views for Drafts / Out for signature / Executed.",
            ]}
            footnote="Reviewers always see the source span and a confidence score before relying on a value."
          />
          <AudienceCard
            tag="For engineers / IT"
            title="Boring stack. No vendor lock-in. AGPL by default."
            bullets={[
              "Postgres + pgvector, FastAPI, React. One docker compose up to run the whole thing.",
              "LiteLLM as the only LLM seam. Local Ollama by default; bring your own OpenAI-compatible provider when you want.",
              "No telemetry, no phone-home, no managed cloud dependency. AGPL-3.0 source, with the receipts.",
            ]}
            footnote="Documents never leave the deployment unless an operator explicitly configures a remote provider."
          />
        </div>
      </div>
    </section>
  );
}

function AudienceCard({
  tag,
  title,
  bullets,
  footnote,
}: {
  tag: string;
  title: string;
  bullets: string[];
  footnote: string;
}) {
  return (
    <article className="flex flex-col rounded-lg border border-rule bg-canvas p-6 sm:p-8">
      <span className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
        {tag}
      </span>
      <h3 className="mt-2 font-serif text-xl text-ink sm:text-2xl">{title}</h3>
      <ul className="mt-5 space-y-3 text-sm text-ink-muted">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-3">
            <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <p className="mt-6 border-t border-rule pt-4 text-xs italic text-ink-subtle">
        {footnote}
      </p>
    </article>
  );
}

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: "Span-cited metadata extraction",
    body: "LLM-driven extraction with mandatory span citations and a confidence score. If a value can't be cited back to the source, it isn't surfaced.",
  },
  {
    title: "CUAD-based clause segmentation",
    body: "Heuristic + model-driven segmentation breaks each contract into typed clauses you can filter, search, and link to.",
  },
  {
    title: "Agreement templates with generation",
    body: "Upload a template, detect `{{variables}}`, review filled values before generation, version the source file with rollback. Every generated draft becomes a regular Repository record.",
  },
  {
    title: "Approval workflows + gates",
    body: "Author per-contract-type approval policies. Workflows route through legal / finance / exec steps; signature is blocked until every required step is approved.",
  },
  {
    title: "Document History + paragraph-aware redline",
    body: "Per-version download, inline preview, base-vs-compare diff exported as DOCX, saved as a redline artifact (never the current document).",
  },
  {
    title: "Embedded e-signature via DocuSeal",
    body: "DocuSeal runs alongside Whereas in the same Docker Compose. On the completion webhook, Whereas materializes a signed-PDF artifact and flips the contract status to executed.",
  },
];

function FeatureGrid() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16 lg:px-10">
        <h2 className="font-serif text-2xl text-ink sm:text-3xl">
          What's in the box
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Pre-v0.1. Some pieces are stubs in the demo; the live deployment
          backs the same UI with Postgres, MinIO, and a model of your choice.
        </p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li
              key={f.title}
              className="rounded-lg border border-rule bg-canvas-subtle p-5"
            >
              <h3 className="text-sm font-medium text-ink">{f.title}</h3>
              <p className="mt-1.5 text-sm text-ink-muted">{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SpanCitationsSection() {
  return (
    <section className="border-t border-rule bg-canvas-subtle">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-ink-subtle">
              The non-negotiable
            </p>
            <h2 className="mt-3 font-serif text-2xl text-ink sm:text-3xl">
              Every value links to its source span.
            </h2>
            <p className="mt-4 text-sm text-ink-muted">
              Extracted metadata, clause classifications, deviation findings,
              Q&A answers — all of it carries a span citation back to the
              original document and a confidence score. The UI shows both.
              If a value can't be cited, it isn't surfaced.
            </p>
            <p className="mt-4 text-sm text-ink-muted">
              That rule is the difference between a tool a legal team can
              actually rely on and a chatbot. Reviewers click a finding and
              see the exact paragraph the model read.
            </p>
          </div>
          <pre
            aria-hidden
            className="overflow-x-auto rounded-lg border border-rule bg-canvas px-4 py-4 font-mono text-xs leading-relaxed text-ink-muted sm:px-5 sm:py-5"
          >
{`field: governing_law
value: "Delaware"
confidence: 0.94
span:
  start: 1428
  end: 1483
  text: "the laws of the State of Delaware, without
         regard to its conflict of laws principles"
model: gpt-oss:20b
prompt_version: "2026-04-15"`}
          </pre>
        </div>
      </div>
    </section>
  );
}

function SelfHostSection() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-[2fr_1fr] lg:gap-12">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-ink-subtle">
              Run it yourself
            </p>
            <h2 className="mt-3 font-serif text-2xl text-ink sm:text-3xl">
              One docker compose up.
            </h2>
            <p className="mt-4 text-sm text-ink-muted">
              Whereas is built around a single-machine baseline. Postgres,
              MinIO, the FastAPI backend, the React frontend, and DocuSeal
              all come up together. No managed-cloud dependency. No
              "enterprise tier" you have to call to unlock.
            </p>
            <p className="mt-4 text-sm text-ink-muted">
              When you outgrow a single box, scale the pieces. The seams are
              standard ones — S3-compatible storage, an OpenAI-compatible
              LLM endpoint via LiteLLM, a Postgres connection string.
            </p>
          </div>
          <pre
            aria-hidden
            className="overflow-x-auto rounded-lg border border-rule bg-canvas-subtle px-4 py-4 font-mono text-xs leading-relaxed text-ink sm:px-5 sm:py-5"
          >
{`$ git clone https://github.com/
    foolish-bandit/whereas
$ cd whereas
$ docker compose up

→ http://localhost:5173`}
          </pre>
        </div>
        <ul className="mt-8 grid gap-4 sm:grid-cols-3">
          <li className="rounded border border-rule bg-canvas-subtle px-4 py-3 text-sm text-ink-muted">
            <span className="block font-medium text-ink">No telemetry.</span>
            Off by default. We don't add it without an explicit, scoped
            request from maintainers.
          </li>
          <li className="rounded border border-rule bg-canvas-subtle px-4 py-3 text-sm text-ink-muted">
            <span className="block font-medium text-ink">No vendor lock-in.</span>
            LiteLLM is the only LLM seam. Local Ollama by default; swap to
            any OpenAI-compatible provider.
          </li>
          <li className="rounded border border-rule bg-canvas-subtle px-4 py-3 text-sm text-ink-muted">
            <span className="block font-medium text-ink">AGPL-3.0.</span>
            Whole tree, root LICENSE file. No per-file headers, no
            dual-licensing shims, no proprietary loadable modules.
          </li>
        </ul>
      </div>
    </section>
  );
}

/**
 * Honest pre-v0.1 status disclosure. Mirrors docs/project-status.md
 * so the marketing copy stays in sync with what's actually shipped.
 */
function HonestStatusSection() {
  return (
    <section className="border-t border-rule bg-canvas-subtle">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16 lg:px-10">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-ink-subtle">
          Where we are
        </p>
        <h2 className="mt-3 max-w-2xl font-serif text-2xl text-ink sm:text-3xl">
          Pre-v0.1, and honest about it.
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-ink-muted">
          Whereas does not pretend to be a finished SaaS. Here's what
          ships today and what is explicitly not built yet.
        </p>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-success-ring bg-success-soft/40 p-6">
            <h3 className="text-sm font-medium uppercase tracking-wider text-success">
              Working today
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-ink-muted">
              <li>· Repository upload, extraction, search, filters, quick views</li>
              <li>· Agreement Templates: upload, variables, generation, history, rollback</li>
              <li>· Requests workspace with template-to-contract conversion</li>
              <li>· Approval policies, workflow templates, runs, tasks, gates</li>
              <li>· DocuSeal send + completion webhook → signed-PDF artifact</li>
              <li>· Document History: download, preview, compare, paragraph-aware redline</li>
              <li>· Audit log with allowlisted detail fields, org-scoped</li>
              <li>· PWA shell, no <code className="font-mono text-xs">/api/*</code> caching</li>
            </ul>
          </div>
          <div className="rounded-lg border border-rule bg-canvas p-6">
            <h3 className="text-sm font-medium uppercase tracking-wider text-ink-subtle">
              Not built yet
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-ink-muted">
              <li>· Real authentication / SSO (dev-user header is the current bridge)</li>
              <li>· User-level RBAC (org-scoping is the only boundary today)</li>
              <li>· Playbook deviation engine (schema landed, evaluator pending)</li>
              <li>· RAG Q&amp;A over the corpus</li>
              <li>· Email / calendar / notification integrations</li>
              <li>· Real-time collaboration / PowerSync sync</li>
              <li>· Production deployment guide (TLS, reverse-proxy, secret rotation)</li>
              <li>· Marketplace of playbooks / templates / clause libraries</li>
            </ul>
          </div>
        </div>
        <p className="mt-6 max-w-2xl text-xs text-ink-subtle">
          A current snapshot lives at{" "}
          <a
            href="https://github.com/foolish-bandit/whereas/blob/main/docs/project-status.md"
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink underline-offset-2 hover:underline"
          >
            docs/project-status.md
          </a>
          .
        </p>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section className="border-t border-rule bg-ink text-canvas">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-10">
        <h2 className="max-w-2xl font-serif text-2xl sm:text-3xl">
          Click around the demo. It's the same UI you'd run locally.
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-canvas/80">
          Sample contracts, sample playbooks, simulated uploads. Nothing
          leaves your browser. The demo runs entirely in-page.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Link
            to="/demo"
            className="inline-flex w-full items-center justify-center rounded border border-canvas bg-canvas px-5 py-3 text-sm font-medium text-ink hover:bg-canvas-subtle sm:w-auto"
          >
            Open the demo
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-full items-center justify-center rounded border border-canvas/40 bg-transparent px-5 py-3 text-sm font-medium text-canvas hover:border-canvas sm:w-auto"
          >
            Read the source
          </a>
        </div>
        <ul className="mt-10 grid gap-3 text-sm text-canvas/80 sm:grid-cols-3">
          <li>
            <Link
              to="/demo/repository"
              className="underline-offset-2 hover:underline"
            >
              → Open Repository
            </Link>
          </li>
          <li>
            <Link
              to="/demo/requests/templates"
              className="underline-offset-2 hover:underline"
            >
              → Open Agreement Templates
            </Link>
          </li>
          <li>
            <Link
              to="/demo/approvals"
              className="underline-offset-2 hover:underline"
            >
              → Open Approvals
            </Link>
          </li>
        </ul>
      </div>
    </section>
  );
}
