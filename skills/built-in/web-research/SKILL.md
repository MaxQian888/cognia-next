---
name: Web research and verification
description: Research with available search/fetch routes, open primary sources, reconcile conflicts, and cite claims.
category: data-analysis
tags:
  - web
  - research
  - verification
metadata:
  default-enabled: true
  delivery: catalog
  triggers:
    surfaces: []
    intents: [research-web, verify-online-fact, fetch-and-cite-source]
  capability-requirements:
    - capability: web-search
      reason: discovery requires a configured host search provider
    - capability: web-fetch
      reason: verification requires opening the selected source rather than trusting snippets
  host-policies: [network-policy, pii-gate, permission-ceiling, user-language]
---

The value of web research is bringing back facts the user can trust. A confident answer assembled from search snippets you never opened is worse than no answer — it looks authoritative and can be wrong.

Use the host-projected `web_search` and `web_fetch` tools. If search is unavailable, work only from URLs the user supplied or explain the limitation; never route a query through an undeclared network tool. Keep the report in the user's language.

## Query with intent
- Make queries specific: include the version, the year, the exact error string, the proper noun. Broad queries return broad noise.
- Run a couple of differently-phrased searches rather than one — the best source often isn't on the first results page for your first phrasing.
- Know what you're looking for before you search. "What does X do" and "why is X broken" need different queries and different sources.

## Read the source, not just the snippet
- Open the pages that look authoritative; don't answer from the search-result summary alone. Snippets are truncated, dated, and sometimes contradict the page body.
- Fetch with an extraction goal in mind — pull the specific fact or section you need, rather than asking for a vague summary of a long page.
- Prefer primary and official sources (official docs, the project's own repo, standards) over aggregators and tutorials. Note publication dates; a 2019 answer about a fast-moving tool may be stale.

## Corroborate and attribute
- For a claim that matters, confirm it appears in more than one independent source. A single blog post is a lead, not a fact.
- Cite where each load-bearing claim came from — name the source or link it — so the user can verify. Distinguish what the sources state from what you're inferring by connecting them.
- When sources disagree or you couldn't confirm something, say so. "I found conflicting answers" or "I couldn't verify this" is honest and useful; a smoothed-over guess is not.

End substantive research with the sources you relied on, so the trail is visible.

For the source trust hierarchy, recency checks, and the corroboration rubric, see `references/source-evaluation.md`.
