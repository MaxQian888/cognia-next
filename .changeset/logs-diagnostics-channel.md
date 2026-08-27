---
"cognia-next": minor
---

Crash logs move into `/logs` as their own **Diagnostics** channel, redesigned. Reading a crash no longer means leaving the page named after logs for Settings → Diagnostics and back — the channel sits between Traces and Incidents, with the sibling channels' chrome (filter row, flat list, resizable detail pane that becomes a sheet on narrow screens). Severity now goes through the app's semantic tones instead of the raw Tailwind palette, so it follows the theme and the style pack; the counts strip became the level filter it used to sit above; and the action row is one icon button group instead of five labelled buttons that wrapped. Settings → Diagnostics keeps the two tabs that are actually settings (Native reports, System).

Also fixes a React render-phase update the channel exposed: the recent-error buffer is recorded on the console bridge's synchronous path, so a `console.error` raised inside any component's render woke `useCrashLogs` mid-render and tripped "Cannot update a component while rendering a different component". The buffer is now read through one shared `useRecentErrorLogs` hook — a stable external-store snapshot whose wake-up is deferred by a microtask — which the error page's recent-errors panel uses too, so both surfaces are safe by construction rather than by luck.
