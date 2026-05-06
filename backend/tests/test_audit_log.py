"""Tests for the hash-chained audit log.

These exercise `compute_entry_hash` directly. It's the load-bearing piece:
chain verification re-runs it against stored records, so any drift in its
inputs, ordering, or serialization breaks every record written under the
prior version. Database-backed tests for `record_event` / `verify_chain`
arrive when the audit migration lands.
"""
from datetime import UTC, datetime

from app.security.audit_log import (
    GENESIS_HASH,
    AuditEventType,
    compute_entry_hash,
)


def _baseline_kwargs() -> dict:
    return {
        "sequence": 1,
        "organization_id": "00000000-0000-0000-0000-000000000001",
        "actor_user_id": "00000000-0000-0000-0000-00000000000a",
        "event_type": AuditEventType.USER_LOGIN_SUCCESS.value,
        "target_type": "user",
        "target_id": "00000000-0000-0000-0000-00000000000a",
        "details": {"ip": "10.0.0.1", "ua": "test"},
        "occurred_at": datetime(2026, 5, 6, 12, 0, 0, tzinfo=UTC),
        "prev_hash": GENESIS_HASH,
    }


class TestHashShape:
    def test_returns_64_char_hex(self) -> None:
        h = compute_entry_hash(**_baseline_kwargs())
        assert len(h) == 64
        # Must be valid hex.
        int(h, 16)

    def test_genesis_hash_shape(self) -> None:
        # Cheap regression guard: GENESIS_HASH must match digest length.
        assert len(GENESIS_HASH) == 64
        assert set(GENESIS_HASH) == {"0"}


class TestHashDeterminism:
    def test_same_inputs_produce_same_hash(self) -> None:
        kw = _baseline_kwargs()
        assert compute_entry_hash(**kw) == compute_entry_hash(**kw)

    def test_independent_invocations_match(self) -> None:
        # Build the kwargs twice from scratch; no shared mutable state.
        h1 = compute_entry_hash(**_baseline_kwargs())
        h2 = compute_entry_hash(**_baseline_kwargs())
        assert h1 == h2


class TestHashSensitivity:
    """Changing any one hashed input must change the output digest."""

    def _h(self, **overrides: object) -> str:
        kw = _baseline_kwargs()
        kw.update(overrides)
        return compute_entry_hash(**kw)  # type: ignore[arg-type]

    def test_sequence_changes_hash(self) -> None:
        assert self._h() != self._h(sequence=2)

    def test_organization_id_changes_hash(self) -> None:
        assert self._h() != self._h(
            organization_id="00000000-0000-0000-0000-000000000002"
        )

    def test_actor_user_id_changes_hash(self) -> None:
        assert self._h() != self._h(
            actor_user_id="00000000-0000-0000-0000-00000000000b"
        )

    def test_actor_user_id_none_vs_string_differs(self) -> None:
        # None and a string-shaped UUID must produce distinct hashes; this
        # catches accidental coercion (e.g., serializing None as "None").
        assert self._h() != self._h(actor_user_id=None)

    def test_event_type_changes_hash(self) -> None:
        assert self._h() != self._h(
            event_type=AuditEventType.USER_LOGOUT.value,
        )

    def test_target_type_changes_hash(self) -> None:
        assert self._h() != self._h(target_type="contract")

    def test_target_type_none_vs_string_differs(self) -> None:
        assert self._h() != self._h(target_type=None)

    def test_target_id_changes_hash(self) -> None:
        assert self._h() != self._h(target_id="some-other-id")

    def test_target_id_none_vs_string_differs(self) -> None:
        assert self._h() != self._h(target_id=None)

    def test_details_value_change_changes_hash(self) -> None:
        assert self._h() != self._h(
            details={"ip": "10.0.0.2", "ua": "test"},
        )

    def test_details_extra_key_changes_hash(self) -> None:
        assert self._h() != self._h(
            details={"ip": "10.0.0.1", "ua": "test", "extra": "x"},
        )

    def test_occurred_at_changes_hash(self) -> None:
        assert self._h() != self._h(
            occurred_at=datetime(2026, 5, 6, 12, 0, 1, tzinfo=UTC),
        )

    def test_prev_hash_changes_hash(self) -> None:
        assert self._h() != self._h(prev_hash="1" * 64)


class TestCanonicalization:
    """`json.dumps(sort_keys=True)` must make dict iteration order irrelevant,
    including for nested dicts inside `details`. If this regresses, two
    semantically identical records would produce different hashes."""

    def test_top_level_details_dict_order_independent(self) -> None:
        kw = _baseline_kwargs()
        kw["details"] = {"a": 1, "b": 2}
        h_ab = compute_entry_hash(**kw)
        kw["details"] = {"b": 2, "a": 1}
        h_ba = compute_entry_hash(**kw)
        assert h_ab == h_ba

    def test_nested_details_dict_order_independent(self) -> None:
        kw = _baseline_kwargs()
        kw["details"] = {"outer": {"a": 1, "b": 2}, "z": 0}
        h_ab = compute_entry_hash(**kw)
        kw["details"] = {"z": 0, "outer": {"b": 2, "a": 1}}
        h_ba = compute_entry_hash(**kw)
        assert h_ab == h_ba

    def test_payload_key_order_in_callers_dict_irrelevant(self) -> None:
        # The payload dict is built inside compute_entry_hash, so the caller
        # cannot change its key order anyway. This test guards against a
        # future refactor that exposes payload construction to callers.
        h1 = compute_entry_hash(**_baseline_kwargs())
        kw = _baseline_kwargs()
        # Re-build kwargs in a different order (Python 3.7+ preserves dict
        # insertion order, so this is meaningful).
        reshuffled = {
            "prev_hash": kw["prev_hash"],
            "occurred_at": kw["occurred_at"],
            "details": kw["details"],
            "target_id": kw["target_id"],
            "target_type": kw["target_type"],
            "event_type": kw["event_type"],
            "actor_user_id": kw["actor_user_id"],
            "organization_id": kw["organization_id"],
            "sequence": kw["sequence"],
        }
        h2 = compute_entry_hash(**reshuffled)
        assert h1 == h2


class TestChainProgression:
    """Build h1 -> h2 -> h3 and verify the linkage matches expectations."""

    _ts = datetime(2026, 5, 6, 12, 0, 0, tzinfo=UTC)

    def _h1(self) -> str:
        return compute_entry_hash(
            sequence=1,
            organization_id="org-1",
            actor_user_id=None,
            event_type=AuditEventType.USER_CREATED.value,
            target_type="user",
            target_id="u1",
            details={},
            occurred_at=self._ts,
            prev_hash=GENESIS_HASH,
        )

    def _h2(self, prev_hash: str) -> str:
        return compute_entry_hash(
            sequence=2,
            organization_id="org-1",
            actor_user_id="u1",
            event_type=AuditEventType.USER_LOGIN_SUCCESS.value,
            target_type="user",
            target_id="u1",
            details={"ip": "10.0.0.1"},
            occurred_at=self._ts,
            prev_hash=prev_hash,
        )

    def _h3(self, prev_hash: str) -> str:
        return compute_entry_hash(
            sequence=3,
            organization_id="org-1",
            actor_user_id="u1",
            event_type=AuditEventType.CONTRACT_UPLOADED.value,
            target_type="contract",
            target_id="c1",
            details={"size_bytes": 1234},
            occurred_at=self._ts,
            prev_hash=prev_hash,
        )

    def test_three_event_chain_is_distinct(self) -> None:
        h1 = self._h1()
        h2 = self._h2(prev_hash=h1)
        h3 = self._h3(prev_hash=h2)
        assert len({h1, h2, h3}) == 3

    def test_wrong_prev_hash_produces_different_hash(self) -> None:
        h1 = self._h1()
        h2_correct = self._h2(prev_hash=h1)
        h2_unlinked = self._h2(prev_hash=GENESIS_HASH)
        assert h2_correct != h2_unlinked

    def test_changing_h1_propagates_no_further_unless_linked(self) -> None:
        # If h1 changes but h2 keeps its old prev_hash, h2 still hashes the
        # same — that's the verification handle: h2.prev_hash will no
        # longer match h1.entry_hash, surfacing the tamper at sequence=2.
        h1 = self._h1()
        h2 = self._h2(prev_hash=h1)

        h1_tampered = compute_entry_hash(
            sequence=1,
            organization_id="org-1",
            actor_user_id=None,
            event_type=AuditEventType.USER_DEACTIVATED.value,
            target_type="user",
            target_id="u1",
            details={},
            occurred_at=self._ts,
            prev_hash=GENESIS_HASH,
        )
        assert h1 != h1_tampered
        # h2 itself didn't change — this is the test: the linkage break
        # is what verify_chain catches, not a recomputed h2.
        assert h2 == self._h2(prev_hash=h1)
