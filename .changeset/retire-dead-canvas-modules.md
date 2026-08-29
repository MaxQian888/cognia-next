---
"cognia-next": patch
---

Remove eight Canvas/Artifacts modules that had no consumer: a second, canvas-local plugin runtime that competed with the real `canvas.toolbar` / `canvas.sidebar` extension points; a JS-side large-file chunking chain that fought Monaco's own virtualization; a web code-execution stub whose only documented caller never existed; two dormant hooks duplicated by live code; a re-export shim; and a compact artifact list every real surface already covered. No behaviour changes.
