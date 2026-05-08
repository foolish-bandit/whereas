/**
 * Marketing landing page.
 *
 * The page is intentionally one long scrollable view: hero, dual-audience
 * split (lawyers / engineers), feature blocks, span-citation explainer,
 * self-host pitch, demo CTA, footer. The demo lives at /demo/* and is
 * always one click away.
 *
 * Copy carefully avoids implying that Whereas provides legal advice — it
 * surfaces information about contracts, with span citations back to
 * source. That phrasing is repeated by design (see CLAUDE.md).
 */
import { Link } from "react-router-dom";

import MarketingFooter from "./MarketingFooter";
import MarketingHeader from "./MarketingHeader";

const GITHUB_URL = "https://github.com/foolish-bandit/whereas";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas-subtle">
      <MarketingHeader />
      <main className="flex-1">
        <Hero />
        <AudienceSplit />
        <FeatureGrid />
        <SpanCitationsSection />
        <SelfHostSection />
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
          mid-sized legal teams. Storage and search, span-cited metadata
          extraction, clause segmentation, and YAML-defined playbook reviews
          — all running on a single machine, behind your firewall.
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
              "Run your firm's playbook against an executed contract and see which clauses pass, fail, or are missing.",
              "Search and filter the whole repository without exporting it to anyone else's cloud.",
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
    title: "Playbook deviation review",
    body: "Author your firm's review positions in YAML. Run a playbook against any contract for deterministic pass/fail outcomes saved as findings.",
  },
  {
    title: "Local-first storage",
    body: "S3-compatible object storage (MinIO out of the box) and Postgres. Original DOCX/PDF stays on your infrastructure as the official artifact.",
  },
  {
    title: "Permission-scoped Q&A",
    body: "RAG questions answered against documents the user can already see, with citations. No cross-tenant leakage.",
  },
  {
    title: "Embedded e-signature",
    body: "DocuSeal runs alongside Whereas in the same Docker Compose. Integrate, don't reimplement.",
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
      </div>
    </section>
  );
}
