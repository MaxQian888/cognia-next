---
"cognia-next": minor
---

Templates and Squads gain real derivation, and both answer to the workspace you are in.

A template you customised can take an upstream update again: the three-way diff now reports each moved path on its own instead of collapsing two unrelated edits into one irreconcilable conflict, and a conflict asks which side wins rather than refusing the update outright. Forking records where the copy came from, with an immutable snapshot of the original, so the library can tell you upstream moved and merge just the parts you want. A fork can also be detached once it has become its own thing.

Squad definitions move into the database. They now belong to a workspace for real rather than by a filter, they go when the workspace does, and they reach a paired phone, which previously listed run history for squads it had no way to name. A squad can be copied, including into another workspace, and saved as a template. New squads start on the durable runtime where the workspace supports it.

The phone gets a real library: scope, domain and trust filters, cards that say where a template came from and what version it is, deep links that open the same thing they open on the desktop, and one-tap forking.
