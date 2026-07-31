---
"cognia-next": minor
---

Three eval subsystem gaps closed: calibration-set identity, version restore/diff, and a readable κ trend.

**Calibration sets now have a real identity.** The set id used to be whatever name you typed, so two sets called "judge-v1" silently merged into one — and because the newest item's criterion won for the whole set, adding a stray item quietly re-attributed every earlier human label to a rubric it was never judged against. Sets now carry an opaque id and a separate human name; the oldest item defines the judge, and a later item naming a different criterion raises a visible mismatch warning instead of overwriting it. The run-detail "send to calibration" flow and the calibration panel both pick or create sets rather than free-typing an id, and repeated names are disambiguated in the picker.

**Dataset version snapshots can be compared and restored.** They were write-only — listable and taggable, but with no way to see what changed between two runs' pinned versions and no way back after a bad edit. The version pane now diffs two snapshots (added / removed / changed / unchanged cases) and restores one, behind an explicit confirmation since restoring deletes cases added since. A restore that would drop cases an id-only snapshot cannot bring back says so first, rather than silently restoring a smaller set than asked for.

**Judge κ history is now a trend, not a flat row of badges.** It had no time axis and no judge attribution, so "did the judge get worse after we changed the rubric?" — the question the history exists to answer — could not be read off it. It now runs oldest→newest with a per-point bar, the change from the previous run, and the judge model that produced each point.
