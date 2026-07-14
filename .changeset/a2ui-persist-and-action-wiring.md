---
"cognia-next": patch
---

Fix Mini Apps (A2UI) breaking after a page reload and inert interactions. Surface state now persists its full component tree and data model, so refreshing no longer leaves apps stuck on a loading spinner and the designer/workspace opens normally; saved apps whose tree was lost by the previous build are rebuilt from their template on load. Built-in mini-app interactions (calculator, timer, to-do, forms, unit converter, …) are now handled app-wide, so buttons work everywhere a surface renders — the Mini Apps hub, the designer, and inline surfaces in chat — with form/submit actions no longer risking a runaway handler loop. The A2UI settings Overview now counts the apps you actually have instead of always showing zero, and the designer's Save button (and ⌘S) durably persist the app instead of only showing a toast.
