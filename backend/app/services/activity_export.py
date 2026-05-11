"""Activity timeline export (PR #75).

Renders the sanitized :class:`ActivityTimelineItem` projection (from
``services/activity_timeline.py``) as a downloadable CSV or JSON file.

Design notes:

* The export deliberately reuses the timeline projection. The
  timeline is the only place that decides which underlying audit
  detail keys are exposed; the export layer formats that already
  sanitized projection into bytes. There is no second, broader
  query path here that could leak raw audit details, storage
  internals, signer PII, document bytes, or DocuSeal secrets.
* CSV columns are a fixed, deterministic allowlist. Missing values
  serialize as empty strings.
* JSON is wrapped in an envelope (``export_type`` / ``generated_at``
  / ``subject_type`` / ``subject_id`` / ``events``) so a downstream
  consumer can see what they got without inspecting filenames.
* Filenames are constructed safely (no path separators, capped
  length, no untrusted text) and returned in ``Content-Disposition``.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import UTC, datetime
from typing import Literal

from app.schemas.activity import ActivityTimelineItem

ExportFormat = Literal["csv", "json"]
SubjectType = Literal["contract", "request"]

CSV_MEDIA_TYPE = "text/csv; charset=utf-8"
JSON_MEDIA_TYPE = "application/json"

# Deterministic CSV column order. Keep this list narrow and
# allowlist-only — every column here must be a field that the
# timeline projection already deems safe to expose. Adding columns
# means adding to ``ActivityTimelineItem`` first.
CSV_COLUMNS: tuple[str, ...] = (
    "occurred_at",
    "event_type",
    "event_id",
    "actor_user_id",
    "title",
    "description",
    "contract_id",
    "request_id",
    "workflow_run_id",
    "approval_step_id",
    "step_order",
    "source",
)

# Allowed format values for the ``?format=`` query param. The API
# layer validates against this set so anything else surfaces as a
# clean 422 rather than a silent fallback.
SUPPORTED_FORMATS: frozenset[str] = frozenset({"csv", "json"})

_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
_FILENAME_MAX_LEN = 120


def render_csv(items: list[ActivityTimelineItem]) -> str:
    """Serialize the items as a CSV string with a header row.

    Uses :mod:`csv` so quoting and escaping match RFC 4180 (commas,
    quotes, and newlines inside fields are handled). Missing fields
    are rendered as empty strings; nested raw audit details are
    never written here.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for item in items:
        writer.writerow([_csv_cell(item, column) for column in CSV_COLUMNS])
    return buffer.getvalue()


def render_json_envelope(
    *,
    subject_type: SubjectType,
    subject_id: uuid.UUID,
    items: list[ActivityTimelineItem],
    generated_at: datetime | None = None,
) -> dict[str, object]:
    """Build the JSON export envelope.

    The events list uses each item's ``model_dump(mode="json")``,
    which is the same shape the timeline API returns — so the
    JSON export is exactly the sanitized timeline projection,
    nothing more.
    """
    when = generated_at if generated_at is not None else datetime.now(UTC)
    return {
        "export_type": "activity_timeline",
        "generated_at": when.isoformat(),
        "subject_type": subject_type,
        "subject_id": str(subject_id),
        "events": [item.model_dump(mode="json") for item in items],
    }


def export_filename(
    *,
    subject_type: SubjectType,
    subject_id: uuid.UUID,
    fmt: ExportFormat,
    generated_at: datetime | None = None,
) -> str:
    """Build a safe download filename.

    Only ASCII letters, digits, dot, underscore, and hyphen survive.
    Length is capped so an aberrant subject id can't blow past the
    filesystem-typical 255-char limit on the receiving side.
    """
    when = generated_at if generated_at is not None else datetime.now(UTC)
    stamp = when.strftime("%Y%m%dT%H%M%SZ")
    raw = f"whereas-{subject_type}-{subject_id}-activity-{stamp}.{fmt}"
    safe = _FILENAME_SAFE_RE.sub("_", raw)
    if len(safe) > _FILENAME_MAX_LEN:
        # Preserve the extension when truncating.
        ext = f".{fmt}"
        safe = safe[: _FILENAME_MAX_LEN - len(ext)] + ext
    return safe


def _csv_cell(item: ActivityTimelineItem, column: str) -> str:
    """Project one column from an :class:`ActivityTimelineItem`.

    Every branch must return a string. ``None`` becomes the empty
    string; UUIDs/datetimes use their canonical string forms.
    """
    if column == "event_id":
        return str(item.id)
    if column == "event_type":
        return item.event_type
    if column == "occurred_at":
        return item.occurred_at.isoformat()
    if column == "actor_user_id":
        return "" if item.actor_user_id is None else str(item.actor_user_id)
    if column == "title":
        return item.title
    if column == "description":
        return item.description or ""
    if column == "contract_id":
        return "" if item.contract_id is None else str(item.contract_id)
    if column == "request_id":
        return "" if item.request_id is None else str(item.request_id)
    if column == "workflow_run_id":
        return "" if item.workflow_run_id is None else str(item.workflow_run_id)
    if column == "approval_step_id":
        return "" if item.approval_step_id is None else str(item.approval_step_id)
    if column == "step_order":
        return "" if item.step_order is None else str(item.step_order)
    if column == "source":
        return item.source or ""
    # Defensive: an unknown column means CSV_COLUMNS drifted from
    # this projection without a corresponding update. Fail loudly in
    # tests rather than silently dropping data.
    raise ValueError(f"Unknown CSV column: {column}")
