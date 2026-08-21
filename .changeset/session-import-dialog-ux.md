---
"cognia-next": patch
---

Import agent sessions dialog: a scan that finds nothing now explains why and
offers the file picker instead of dead-ending on "No sessions found", an
unrecognized pick offers "Try again" rather than only "Close", and a session list
can be backed out of without closing the dialog. Picking a mixed selection now
imports every agent it recognizes instead of silently keeping only the first, a
source that claims your files but cannot read them is reported rather than
dropped, and the dialog names the agents whose history lives inside each
repository (Aider) and therefore can only be reached by choosing files yourself.
