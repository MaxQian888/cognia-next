---
"cognia-next": patch
---

Artifact previews follow your theme instead of always painting on a light background, and a transcript full of artifact cards no longer mounts every preview at once — cards render as you reach them, and React artifacts (which load a runtime) wait for a click.

Syntax highlighting also stops running several code blocks at the same time. Scrolling into a run of fenced code fused their work into one long freeze; it now queues, which keeps scrolling responsive.
