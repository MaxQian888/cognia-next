---
"cognia-next": patch
---

Fix the workflow run-history page crashing with an application error ("Cannot read properties of undefined (reading 'name')") when a run row has no embedded workflow snapshot — run rows written by older schema versions or imported histories now fall back to the workflow id in the header instead of taking down the whole route.
