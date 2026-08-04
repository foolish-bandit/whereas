from pathlib import Path

MODEL_PATH = (
    Path(__file__).resolve().parents[1]
    / "app"
    / "models"
    / "remediation.py"
)


def test_model_declares_typed_links_and_safe_provenance() -> None:
    source = MODEL_PATH.read_text(encoding="utf-8")
    assert 'class FindingRemediationTask(Base)' in source
    assert '__tablename__ = "finding_remediation_tasks"' in source
    assert 'ForeignKey("deviation_findings.id", ondelete="CASCADE")' in source
    assert 'ForeignKey("inbox_items.id", ondelete="CASCADE")' in source
    assert "source_type" in source
    assert "source_id" in source
    assert "evidence_text" not in source
    assert "suggested_language" not in source
