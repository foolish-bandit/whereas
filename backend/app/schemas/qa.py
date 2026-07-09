"""Request and response schemas for `POST /api/qa/ask` (`app.api.qa`).

Per design principle #2 (span citations are mandatory), `AskResponse`
has no path that surfaces free-text answer content without at least
one citation that has been verified, verbatim, against the source
clause. `answerable=False` is the explicit "we could not cite this"
refusal shape — it is not an error, it is the correct response when
retrieval finds nothing or the model's claimed citations don't hold up.
"""
from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict, Field


class AskRequest(BaseModel):
    """Body for `POST /api/qa/ask`."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(..., min_length=1, max_length=2000)
    # Optional scope: when set, retrieval only considers clauses from
    # this contract (still org-scoped underneath).
    contract_id: uuid.UUID | None = None


class CitationResponse(BaseModel):
    """One validated citation backing an answer.

    `quote` is guaranteed to appear verbatim in `Contract.full_text`
    between `start_offset` and `end_offset` — the same span-validation
    discipline `app.services.extraction` applies to extracted metadata.
    """

    contract_id: uuid.UUID
    contract_title: str
    clause_id: uuid.UUID
    heading: str | None
    quote: str
    start_offset: int
    end_offset: int


class AskResponse(BaseModel):
    """Response for `POST /api/qa/ask`.

    When `answerable` is `False`, `answer` is a fixed refusal message,
    `citations` is empty, and `confidence` is `0.0` — never a
    free-floating claim with nothing behind it.
    """

    answerable: bool
    answer: str
    citations: list[CitationResponse] = Field(default_factory=list)
    confidence: float
    model: str | None = None
