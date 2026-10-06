---
"cognia-next": patch
---

Staying signed in to the Cognia account no longer fails when several parts of the app (or several windows) renew the sign-in at the same moment: renewals now happen one at a time, and a renewal that lost the race uses the winner's session instead of asking you to sign in again.
