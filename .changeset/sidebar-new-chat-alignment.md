---
"cognia-next": patch
---

Fix the sidebar "New chat" row sitting 4px right of the navigation rows: `Button`'s `has-[>svg]:px-3` fired on its bare icon child, so the row now renders through the shared `SidebarRow` like every other row.
