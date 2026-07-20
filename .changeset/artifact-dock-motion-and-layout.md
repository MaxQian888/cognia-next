---
"cognia-next": minor
---

Polish the chat artifact/workspace dock. The dock collapse/expand and the artifact and workspace sheet animations now honor your motion-speed preference (Settings → Appearance → Accessibility) instead of running at a fixed pace. A new artifact no longer force-reopens the dock after you have manually collapsed it — a small unread dot on the header's dock toggle surfaces it instead, and clears when you open the panel. The workspace mode of the dock can now grow wider (up to ~65%) and keeps a pixel-based minimum width so the file tree, editor, and diff stay usable on smaller screens. Finally, opening a review/diff from a terminal link no longer gets stuck on the file view when it fires before Git has finished loading.
