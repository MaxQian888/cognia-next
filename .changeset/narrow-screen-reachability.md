---
"cognia-next": patch
---

Fix four places where a narrow window hid controls instead of wrapping them. The feature page header's navigation slots now scroll their own overflow like the controls slot already did, so /eval's four tabs and /logs' refresh and overflow buttons stay reachable at phone width. The workspace tab strip scrolls instead of clipping "Source Control". The agent runs cockpit moves its detail into a drawer rather than parking it off the right edge. A log row lets its message take a full-width line instead of breaking at every hyphen.
