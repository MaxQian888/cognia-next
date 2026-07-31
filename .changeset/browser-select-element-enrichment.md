---
"cognia-next": minor
---

Enrich the in-app browser's element selection. Picking an element in a React dev preview now reads its owning component (name, component path and shallow props) straight from the fiber tree, and — when the dev build emits `data-inspector-*` attributes — its exact source file and line. That context ships to the chat agent along with a directive that points it straight at the component's definition, so "make this button green" maps to the right source without guesswork. A new panel next to the selected element shows a basic identity (tag · component · size) that expands to the full detail (selector, component stack, source, props, text) on demand, and the comment box now labels what you selected by component name. Non-React pages and dev builds without inspector attributes degrade gracefully to the previous selector/HTML-based flow.
