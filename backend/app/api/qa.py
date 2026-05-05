"""Q&A over the contract repository (RAG).

v0.1 scope:
  - Single-turn questions scoped to a single contract or the full corpus.
  - Answers must cite the clauses they're drawn from.
  - Permissioning: only contracts the user can read are candidate retrieval targets.

Post-v0.1: multi-turn conversations, structured queries ("show me all NDAs
expiring in Q3"), cross-contract analytics.
"""
from fastapi import APIRouter

router = APIRouter()


@router.post("/ask")
async def ask(question: str, contract_id: str | None = None) -> dict:
    """Ask a question. If contract_id is provided, scope retrieval to that contract.

    Response shape (to be implemented):
      {
        "answer": str,
        "citations": [
          {"contract_id": str, "clause_id": str, "snippet": str, "span": {...}}
        ],
        "confidence": float
      }
    """
    return {"status": "not_implemented", "question": question}
