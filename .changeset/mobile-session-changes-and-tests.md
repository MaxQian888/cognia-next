---
"cognia-next": minor
---

Show a remote session's file changes and test results on mobile.

Following an agent session from a phone previously showed only the transcript — what was said, never what happened to the code. The session view now has three tabs. Changes lists the files the selected turn touched and opens each one's diff on demand; Tests shows what the turn's verification runs reported. Both are read-only, and the approval prompt and follow-up composer stay available on every tab, so an approval can never end up hidden behind a tab while the run waits on it.

Diffs render with the same plain renderer the chat transcript uses rather than the desktop code editor, which is not something a phone should be asked to load.

Every file that will not show a diff says why instead of showing an empty pane. A credential-shaped file such as `.env` is reported as withheld and its contents are never requested from the desktop at all. Binary files, symbolic links, and added, deleted or renamed files are each named as such, because the desktop keeps no line-by-line diff for them and an empty pane would otherwise read as "this file is unchanged". Line counts are shown only where they were actually recorded, so an added file is never reported as adding nothing.

A turn with more than one attempt can be switched between, and switching collapses any open file so a diff from the previous attempt is never left on screen under the new one's file list.

Test results distinguish the three outcomes honestly: a run whose output could not be parsed is shown as inconclusive in amber, never as a green zero. The empty states are likewise kept apart — "no run for this session has reached this device yet" is a different answer from "no turn in this session ran any tests", and they are no longer reported as the same thing.
