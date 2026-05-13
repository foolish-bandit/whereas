import {
  getQuestionSetFor,
  type SupportingAnswers,
  type SupportingQuestionSet,
} from "../lib/supportingQuestions";

interface Props {
  /** Selected request_type (e.g. `nda_review`, `vendor_agreement`). */
  requestType: string | null | undefined;
  /** Selected contract type (free-text or slug, e.g. `NDA`, `mutual_nda`). */
  contractType: string | null | undefined;
  /** Current answers keyed by question id. */
  answers: SupportingAnswers;
  /** Patch the answers map. The caller is responsible for state. */
  onChange: (next: SupportingAnswers) => void;
  /**
   * Optional override for the matched question set. Useful when the
   * caller wants to inject template-specific questions (e.g. once
   * Agreement Templates expose a contract_type slug). Defaults to
   * `getQuestionSetFor(requestType, contractType)`.
   */
  set?: SupportingQuestionSet | null;
  /**
   * Optional short helper line rendered under the panel subtitle. Used
   * by callers to disclose when the question set is tailored from a
   * selected Agreement Template, so users understand why the prompts
   * changed when they picked a template. Skipped when not provided.
   */
  hint?: string | null;
  /** Test-id prefix so the same panel can be used in multiple surfaces. */
  testIdPrefix?: string;
}

/**
 * PR #126 — guided supporting questions for Request intake.
 *
 * Renders a short, contract-type-aware question set. Answers are
 * **optional** — the panel exists to help requesters give legal the
 * context they need, not to gate submission.
 *
 * The component is purely presentational on top of the question
 * config in `lib/supportingQuestions`. It does not call the API and
 * does not own the answers map; the parent decides how to summarise
 * answers into the existing free-text description field at submit
 * time.
 */
export default function SupportingQuestionsPanel({
  requestType,
  contractType,
  answers,
  onChange,
  set: setOverride,
  hint,
  testIdPrefix = "supporting-questions",
}: Props) {
  const set =
    setOverride !== undefined
      ? setOverride
      : getQuestionSetFor(requestType, contractType);

  if (!set) {
    return (
      <div
        className="rounded border border-rule bg-canvas-subtle px-3 py-2 text-xs text-ink-muted"
        data-testid={`${testIdPrefix}-pending`}
      >
        Pick a request type or contract type above to see guided
        supporting questions for that flow.
      </div>
    );
  }

  function update(id: string, value: string) {
    onChange({ ...answers, [id]: value });
  }

  return (
    <section
      className="space-y-2 rounded border border-rule p-3"
      data-testid={testIdPrefix}
      data-supporting-question-group={set.key}
      aria-labelledby={`${testIdPrefix}-heading`}
    >
      <div>
        <h3
          id={`${testIdPrefix}-heading`}
          className="text-sm font-medium text-ink"
        >
          Supporting questions · {set.heading}
        </h3>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Answer what you know. These help reviewers understand the
          business context before review begins. All fields are
          optional.
        </p>
        {hint && (
          <p
            className="mt-1 text-xs text-ink-subtle"
            data-testid={`${testIdPrefix}-hint`}
          >
            {hint}
          </p>
        )}
      </div>
      <div className="grid gap-2">
        {set.questions.map((q) => (
          <label
            key={q.id}
            className="grid gap-1 text-xs text-ink-muted"
            data-testid={`${testIdPrefix}-row`}
            data-supporting-question-id={q.id}
          >
            <span>{q.label}</span>
            {q.kind === "long" ? (
              <textarea
                className="min-h-[3rem] rounded border border-rule px-2 py-1 text-sm text-ink"
                value={answers[q.id] ?? ""}
                onChange={(e) => update(q.id, e.target.value)}
                placeholder={q.placeholder}
                data-testid={`${testIdPrefix}-input`}
                data-supporting-question-input={q.id}
              />
            ) : (
              <input
                className="rounded border border-rule px-2 py-1 text-sm text-ink"
                value={answers[q.id] ?? ""}
                onChange={(e) => update(q.id, e.target.value)}
                placeholder={q.placeholder}
                data-testid={`${testIdPrefix}-input`}
                data-supporting-question-input={q.id}
              />
            )}
          </label>
        ))}
      </div>
    </section>
  );
}
