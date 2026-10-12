---
"cognia-next": patch
---

Make the chat's right dock and the terminal dock move without stalls: collapsing and re-opening the dock keeps the Workspace (project tree, git state, editors) alive instead of reloading it; switching between artifact and Workspace tabs no longer rebuilds the project editor; tabs no longer change the dock's width (every tab now uses the Workspace's size); moving the terminal between the bottom and the right keeps the same live terminal; and collapsing the sidebar or the dock no longer flashes the dark page background.
