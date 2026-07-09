import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import AskPanel from "../AskPanel";
import type { AskResponse } from "../../types/qa";
import { expectNoForbiddenTokens } from "../../test/forbiddenTokens";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>(
    "../../lib/api",
  );
  return {
    ...actual,
    askQuestion: vi.fn(),
  };
});

import { ApiError, askQuestion } from "../../lib/api";

const CONTRACT_ID = "00000000-0000-4000-8000-000000000222";
const CLAUSE_ID = "00000000-0000-4000-8000-000000000555";

const ANSWERABLE_RESPONSE: AskResponse = {
  answerable: true,
  answer: "The termination notice period is thirty (30) days.",
  citations: [
    {
      contract_id: CONTRACT_ID,
      contract_title: "Mutual NDA (sample)",
      clause_id: CLAUSE_ID,
      heading: "5. Termination",
      quote: "thirty (30) days' prior written notice",
      start_offset: 40,
      end_offset: 79,
    },
  ],
  confidence: 0.85,
  model: "ollama/llama3",
};

const REFUSAL_RESPONSE: AskResponse = {
  answerable: false,
  answer:
    "I could not find an answer to this question in your contracts. " +
    "Whereas only answers from indexed contract text and does not guess " +
    "or provide legal advice.",
  citations: [],
  confidence: 0,
  model: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function askAndSubmit(question: string) {
  const textarea = screen.getByLabelText("Question");
  fireEvent.change(textarea, { target: { value: question } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));
  });
}

describe("AskPanel", () => {
  it("renders a question input with the submit button disabled until text is entered", () => {
    render(<AskPanel contractId={CONTRACT_ID} />);
    expect(screen.getByLabelText("Question")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "What is the term?" },
    });
    expect(screen.getByRole("button", { name: /ask/i })).toBeEnabled();
  });

  it("submits the question scoped to contractId and shows a loading state", async () => {
    let resolveFn: (value: AskResponse) => void = () => {};
    vi.mocked(askQuestion).mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    render(<AskPanel contractId={CONTRACT_ID} />);
    await askAndSubmit("What is the termination notice period?");

    expect(askQuestion).toHaveBeenCalledWith({
      question: "What is the termination notice period?",
      contract_id: CONTRACT_ID,
    });
    expect(screen.getByRole("button", { name: /asking/i })).toBeDisabled();

    resolveFn(ANSWERABLE_RESPONSE);
    await waitFor(() =>
      expect(screen.getByTestId("ask-panel-answer")).toBeInTheDocument(),
    );
  });

  it("renders the answer, confidence badge, and citation cards for an answerable response", async () => {
    vi.mocked(askQuestion).mockResolvedValue(ANSWERABLE_RESPONSE);
    render(<AskPanel contractId={CONTRACT_ID} />);
    await askAndSubmit("What is the termination notice period?");

    const answerArea = await screen.findByTestId("ask-panel-answer");
    expect(answerArea).toHaveTextContent(
      "The termination notice period is thirty (30) days.",
    );
    expect(answerArea).toHaveTextContent("85%");
    expect(answerArea).toHaveTextContent("Mutual NDA (sample)");
    expect(answerArea).toHaveTextContent("5. Termination");
    expect(answerArea).toHaveTextContent(
      "thirty (30) days' prior written notice",
    );
    expect(answerArea).toHaveTextContent("ollama/llama3");
  });

  it("calls onCitationSelect with the clause id and offsets when a citation card is clicked", async () => {
    vi.mocked(askQuestion).mockResolvedValue(ANSWERABLE_RESPONSE);
    const onCitationSelect = vi.fn();
    render(
      <AskPanel contractId={CONTRACT_ID} onCitationSelect={onCitationSelect} />,
    );
    await askAndSubmit("What is the termination notice period?");
    await screen.findByTestId("ask-panel-answer");

    fireEvent.click(
      screen.getByText(/thirty \(30\) days' prior written notice/i),
    );
    expect(onCitationSelect).toHaveBeenCalledWith(CLAUSE_ID, 40, 79);
  });

  it("renders a distinct, honest empty-state for a grounded refusal", async () => {
    vi.mocked(askQuestion).mockResolvedValue(REFUSAL_RESPONSE);
    render(<AskPanel contractId={CONTRACT_ID} />);
    await askAndSubmit("What is the meaning of life?");

    const refusal = await screen.findByTestId("ask-panel-refusal");
    expect(refusal).toHaveTextContent(
      "No supported answer found in your documents.",
    );
    expect(screen.queryByTestId("ask-panel-answer")).toBeNull();
  });

  it("shows a friendly unavailable message on a 503 error", async () => {
    vi.mocked(askQuestion).mockRejectedValue(
      new ApiError(503, "Question answering is temporarily unavailable."),
    );
    render(<AskPanel contractId={CONTRACT_ID} />);
    await askAndSubmit("What is the term?");

    const error = await screen.findByTestId("ask-panel-error");
    expect(error).toHaveTextContent(/temporarily unavailable/i);
  });

  it("surfaces other ApiError messages (e.g. a 403 policy block) directly", async () => {
    vi.mocked(askQuestion).mockRejectedValue(
      new ApiError(403, "Question answering is blocked by configured policy."),
    );
    render(<AskPanel contractId={CONTRACT_ID} />);
    await askAndSubmit("What is the term?");

    const error = await screen.findByTestId("ask-panel-error");
    expect(error).toHaveTextContent("blocked by configured policy");
  });

  it("never renders forbidden internal tokens", async () => {
    vi.mocked(askQuestion).mockResolvedValue(ANSWERABLE_RESPONSE);
    render(<AskPanel contractId={CONTRACT_ID} />);
    await askAndSubmit("What is the termination notice period?");
    await screen.findByTestId("ask-panel-answer");
    expectNoForbiddenTokens(document.body.textContent);
  });
});
