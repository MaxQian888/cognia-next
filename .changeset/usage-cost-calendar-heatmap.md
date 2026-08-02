---
"cognia-next": minor
---

Settings → Subscription → Usage: "Cost over time" now draws a GitHub-style calendar heatmap by default, with a toggle back to the original bar chart. Every day in the selected range gets a cell — including days with no spend — and each cell carries a localized date, its USD cost and request count as both an aria-label and a tooltip that opens on hover _and_ on keyboard focus. Daily usage is now bucketed by your local calendar day instead of UTC, so a late-night turn lands on the day you remember spending it. The time-range toggle replaces the misleading "All time" option with "Last 90 days", which matches how long usage rows are actually retained.
