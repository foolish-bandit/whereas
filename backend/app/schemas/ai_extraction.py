"""Typed schemas for AI extraction outputs.

GLiNER-family extraction is planned but not yet active in product behavior.
These schemas define the span-grounded contract for future local/self-hosted
small-model extraction and manual review workflows.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator


class ExtractionSource(StrEnum):
    """Source of an extracted entity value."""

    RULE = "rule"
    GLINER = "gliner"
    MANUAL = "manual"
    UNKNOWN = "unknown"


class ExtractedEntity(BaseModel):
    """Span-grounded extracted entity."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=lambda: str(uuid4()), min_length=1)
    label: str = Field(min_length=1)
    text: str = Field(min_length=1)
    span_start: int = Field(ge=0)
    span_end: int = Field(gt=0)
    confidence: float = Field(ge=0.0, le=1.0)
    source: ExtractionSource = ExtractionSource.UNKNOWN
    reviewed: bool = False
    normalized_value: str | None = None
    notes: str | None = None

    @field_validator("label", "text")
    @classmethod
    def _non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("span_end")
    @classmethod
    def _validate_span_order(cls, value: int, info: Any) -> int:
        span_start = info.data.get("span_start")
        if isinstance(span_start, int) and value <= span_start:
            raise ValueError("span_end must be greater than span_start")
        return value

    def validate_against_source_text(self, source_text: str) -> None:
        """Validate span bounds and text match against a known source string."""
        if self.span_end > len(source_text):
            raise ValueError("span_end is out of bounds for source text")
        if source_text[self.span_start : self.span_end] != self.text:
            raise ValueError("entity text does not match source text at span")


class ExtractionResult(BaseModel):
    """Top-level extraction result payload."""

    model_config = ConfigDict(extra="forbid")

    artifact_id: UUID | None = None
    document_id: UUID | None = None
    model_name: str | None = None
    model_version: str | None = None
    entities: list[ExtractedEntity] = Field(default_factory=list)
    created_at: datetime | None = None

    @field_validator("model_name", "model_version")
    @classmethod
    def _strip_empty_optional_strings(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


class ExtractionFieldPayload(BaseModel):
    """Validated shape of one field in the raw LLM metadata-extraction
    response (see ``app.prompts.extraction.EXTRACTION_SYSTEM_PROMPT``).

    Used by ``app.services.extraction`` as a validation gate: a parsed
    LLM response that fails to validate against
    ``MetadataExtractionResponse`` triggers a single corrective reask
    (Instructor-style) before extraction gives up. ``value`` is
    intentionally untyped since its shape differs per field (string,
    number, list, nested object); ``confidence`` is validated strictly
    since it's the piece weak local models most often return
    out-of-range or omit. Unknown extra keys within a field payload are
    ignored rather than rejected, so chatty models don't trigger a
    reask over harmless noise.
    """

    model_config = ConfigDict(extra="ignore")

    value: Any = None
    span: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)


class MetadataExtractionResponse(RootModel[dict[str, ExtractionFieldPayload]]):
    """Top-level shape of the raw LLM metadata-extraction response: a
    mapping of field name -> ``ExtractionFieldPayload``.
    """


def assert_no_raw_document_bytes(payload: Mapping[str, Any] | Sequence[Any] | Any) -> None:
    """Reject payloads that include raw document bytes at any depth."""
    if isinstance(payload, (bytes, bytearray, memoryview)):
        raise ValueError("raw document bytes are forbidden in extraction payloads")
    if isinstance(payload, Mapping):
        for value in payload.values():
            assert_no_raw_document_bytes(value)
        return
    if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray, memoryview)):
        for item in payload:
            assert_no_raw_document_bytes(item)
