import { isDemoMode } from "../lib/env";

export type SimilarityLabel = "High" | "Medium" | "Low";

export interface SimilarClauseMatch {
  id: string;
  title: string;
  contract_type: string;
  clause_type: string;
  similarity_label: SimilarityLabel;
  basis: string;
  approved_language_preview: string;
  href?: string | null;
}

interface SimilarClausesPanelProps {
  sourceClauseTitle: string;
  sourceClauseText: string;
  matches?: SimilarClauseMatch[];
}

export function seededDemoMatches(
  sourceClauseTitle: string,
  sourceClauseText: string,
): SimilarClauseMatch[] {
  const pool: SimilarClauseMatch[] = [
    {
      id: "cm-nda-conf-01",
      title: "Mutual NDA — Confidentiality carveouts",
      contract_type: "NDA",
      clause_type: "Confidentiality",
      similarity_label: "High",
      basis: "Shares carveout structure and disclosure exceptions.",
      approved_language_preview:
        "Confidential Information excludes data already public, lawfully received from a third party, or independently developed.",
      href: "/clause-manager?clause_id=cm-nda-conf-01",
    },
    {
      id: "cm-msa-term-03",
      title: "MSA — Term and termination notice",
      contract_type: "MSA",
      clause_type: "Termination",
      similarity_label: "Medium",
      basis: "Same notice mechanic, different cure period language.",
      approved_language_preview:
        "Either party may terminate for material breach after thirty (30) days' written notice and opportunity to cure.",
      href: "/clause-manager?clause_id=cm-msa-term-03",
    },
    {
      id: "cm-saa-law-07",
      title: "SaaS Order Form — Governing law",
      contract_type: "SaaS",
      clause_type: "Governing Law",
      similarity_label: "Low",
      basis: "Overlaps on governing law concept but uses a different venue approach.",
      approved_language_preview:
        "This Agreement is governed by New York law, excluding conflict-of-laws principles, with exclusive venue in New York County.",
      href: null,
    },
  ];

  const seed = `${sourceClauseTitle}::${sourceClauseText}`.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const start = seed % pool.length;
  return [pool[start], pool[(start + 1) % pool.length]];
}

export default function SimilarClausesPanel({
  sourceClauseTitle,
  sourceClauseText,
  matches,
}: SimilarClausesPanelProps) {
  const demoMode = isDemoMode();
  const resolvedMatches =
    matches ?? (demoMode ? seededDemoMatches(sourceClauseTitle, sourceClauseText) : []);

  const shouldRender = demoMode || Boolean(matches);
  if (!shouldRender) return null;

  return (
    <section className="rounded-lg border border-rule bg-canvas p-4" aria-label="Similar clauses">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Similar approved clauses</h3>
        <span className="rounded-full border border-info/40 bg-info-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-info">
          Demo preview
        </span>
      </div>
      <p className="mb-3 text-xs text-ink-subtle">
        Planned small-model retrieval. This panel currently shows deterministic demo data and does not run embeddings or reranking.
      </p>
      <p className="mb-3 text-xs text-ink-muted">
        Source clause: <span className="font-medium text-ink">{sourceClauseTitle}</span>
      </p>

      {resolvedMatches.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Clause similarity is planned. Once embeddings are enabled, Whereas will compare this clause against approved Clause Manager language.
        </p>
      ) : (
        <ul className="space-y-3">
          {resolvedMatches.map((match) => (
            <li key={match.id} className="rounded-md border border-rule bg-canvas-subtle p-3">
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink">{match.title}</p>
                <span className="rounded-full border border-rule bg-canvas px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                  {match.similarity_label}
                </span>
              </div>
              <p className="text-xs text-ink-subtle">
                {match.contract_type} · {match.clause_type}
              </p>
              <p className="mt-1 text-xs text-ink-muted">{match.basis}</p>
              <p className="mt-2 text-xs text-ink">{match.approved_language_preview}</p>
              {match.href ? (
                <a className="mt-2 inline-block text-xs text-info underline" href={match.href}>
                  Open in Clause Manager
                </a>
              ) : (
                <p className="mt-2 text-xs text-ink-subtle">No Clause Manager link available.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
