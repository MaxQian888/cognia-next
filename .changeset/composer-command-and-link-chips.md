---
"cognia-next": minor
---

Rework how the composer shows commands and links, and fix what was broken around them.

Links: a pasted URL now folds to a short label right in the input — `svenstaro/genact` with GitHub's own mark in front of it, blue and underlined like a link reads everywhere else — while the full URL comes back on copy, on cut, and on send. Shortening rules are built in for repository hosts and customisable under Settings → Conversation (host → prefix to drop). ⌘/Ctrl-click opens the link, in the embedded browser pane when one is open. Backspace anywhere in a folded link removes the whole thing.

Commands: `/command` pills line up with the glyphs under a monospace composer skin; the completion panel closes once there is nothing left to complete, so a chained line (`/clear /resume `) no longer reopens it on the FIRST command and Enter no longer overwrites it; a link is inert, so a command typed after one still runs and still completes; and command-list search stops matching a description that merely contains the query as a scattered subsequence.

Above the box: only what has no form in the text is chipped there now — attachments, `@`-references, artifacts, plus any command that failed — and that row folds past its first line instead of stacking a band per kind. The two corner controls (save-as-template, preview) were unclickable under the textarea's stacking layer; they now sit above it, have tooltips, and the bookmark takes the corner when there is no preview toggle. Toggling the parameter preview no longer paints the raw text over the substituted one.
