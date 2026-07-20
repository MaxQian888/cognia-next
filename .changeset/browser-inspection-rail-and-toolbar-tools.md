---
"cognia-next": minor
---

Browser preview: side-rail refactor + zoom / find / history

- **Inspection side rail**: the element-selection and annotation-queue panels now
  slide into a fixed-width rail beside the reserved region instead of stacking
  below it. Entering/leaving inspection resizes the native webview at most once
  (one `embedSetBounds`) instead of jumping 2–3 times, and the annotation queue
  scrolls inside the rail rather than pushing the recorder off-screen. The
  loading and empty states now fade in.
- **Zoom**: a `[ − ] 100% [ + ]` control (native `Webview::set_zoom` via the new
  `browser_embed_set_zoom` command) with the percentage doubling as reset;
  persisted per session and re-applied across navigations/webview recreation.
- **Find-in-page**: a Ctrl/Cmd+F find bar (and toolbar button) with match
  counter and prev/next, highlighting matches via the CSS Custom Highlight API
  (with a `<mark>` fallback), driven by a shared `__cogniaFind` overlay helper.
- **History menu**: a recent-URL dropdown next to the reload button to jump back
  to earlier local pages.

Zoom, find, and history also work on the remote (cloud-Chromium) preview: the
find helper is shared through the injected overlay, zoom applies CSS `zoom`
(re-applied after navigation), and both route through the companion RPC gateway
(`browser_set_zoom` / `browser_find` / `browser_find_clear`) into the workspace
runtime.
