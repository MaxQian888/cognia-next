---
"cognia-next": patch
---

Cleaned up the settings page header: removed the redundant icon tile next to the title and the sidebar-collapse trigger (the sidebar still toggles via its edge rail, ⌘/Ctrl+B, and the collapsed icon rail). Converted "Verify enabled" / "Retry failed" / "Reset section" text buttons into ghost icon buttons matching the search trigger and actions menu, all size-8 with downward hover tooltips. The back button now pops history like the mobile sub-page shell instead of always pushing `/`, so the global back arrow no longer re-enters the settings page just left.
