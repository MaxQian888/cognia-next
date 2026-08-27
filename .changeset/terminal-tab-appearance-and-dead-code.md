---
"cognia-next": minor
---

Terminal tabs can now be given a colour and an icon: the grids live in the tab's right-click menu under Appearance, and the tab strip paints the chosen colour. Every layer of this had shipped except the one connecting the menu to the picker, so the menu item never rendered.

Also removes three modules that nothing could reach: the terminal command-template dialog and its engine (no surface ever ran a template), the old shell member list (superseded by the context workbench's team-members panel), and the old command-palette chat-history search group (superseded by the unified global search).
