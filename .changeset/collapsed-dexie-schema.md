---
"cognia-next": minor
---

The local database now declares its schema as one current version instead of replaying 200 historical migration steps on every launch. Constructing it drops from roughly 4.7 seconds to about 3 milliseconds, which is time removed from every cold start, every account unlock, and every switch between hosts.

Because there is no migration chain left to carry an old database forward, a database written by an earlier build is now refused at boot rather than opened and misread. The lock screen explains what happened and offers a one-click reset of this device's local data, which no password could have cleared on its own. Backups and other devices are unaffected.

Also repairs the data-governance gate, which had been passing its own unit tests while being unable to parse the schema file at all, and adds the `projectMiningRuns` table it had drifted out of sync with.
