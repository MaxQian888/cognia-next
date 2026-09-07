---
"cognia-next": patch
---

The `/squads` run filter chips now count the list they sit above. They were tallying every run in the journal while the list below applied the Squad pinning on top, so the Runs tab read "All 6 / Failed 1 / Finished 5" over "No runs match these filters". One model (`buildCockpitFacets`) now owns both the rows and every number, so a chip reports exactly how many rows selecting it renders. The chips are also live on `/squads` for the first time, with the status bucket riding in `?status=`, where before they were clickable and inert. The kind dropdown is hidden where the host pins the kind rather than shown unchangeable, and an empty Squad reads "No runs yet" instead of blaming a filter the reader has no control for.
