---
"cognia-next": patch
---

Deep Research: section searches now use the configured results-per-query width. `runDeepResearch` passed `searchResultsPerQuery: undefined` into the per-section config, which overwrote `DEFAULT_CONFIG`'s value in the `{ ...DEFAULT_CONFIG, ...override }` merge, so every section search requested `undefined` results instead of 6. A caller-supplied width is still honoured.
