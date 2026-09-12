---
"cognia-next": minor
---

/web-clone: add --convert to re-run component extraction + codegen on a saved snapshot without fetching, expose the tuning/codegen flags the engine supports (--framework-hint, --max-assets, --concurrency, --timeout, --max-file-size, --pretty, --extract-components, --drafts, --extract-shared, --no-typescript), make the argv parser strict (unknown flags, missing values, extra positionals and the url+--convert combination are reported instead of silently dropped), localize all command output in en/zh-CN, and return the result through the structured command contract so it lands in the chat transcript. io.webClone gains a matching "convert local snapshot" field, and relative output/convertLocal paths can no longer escape the workspace via `..` segments.
