---
"cognia-next": minor
---

Put the search and retrieval model calls that live in the shared packages on the Router + Fusion call ledger. With the "Utility generation" surface turned on (设置 → AI 连接 → 路由), the standalone web answer, the Google AI grounded search, and project-knowledge query expansion (HyDE / step-back) are now reserved before they leave and settled from what the provider reported — so they appear in the run list and count against the budget like every other ledgered call, with the reservation's own output limit and no hidden SDK retries. Nothing changes while the surface is off (the default): those calls are byte-for-byte what they were, and no Router + Fusion code loads. If the ledger itself cannot be reached, the call still goes out on its original path, unledgered, with a notice. The same seam is available to the RAG pipeline's other model stages (rerank, grading, grounding, evaluation, contextual retrieval, semantic chunking) for the hosts that will use them.
