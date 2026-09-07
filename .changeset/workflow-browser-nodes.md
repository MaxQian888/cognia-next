---
"cognia-next": minor
---

Workflows can drive a browser. Nine new nodes open a page, snapshot it, read it as text, click and type, fill a form, wait for a condition, screenshot it, read its console and network, and replay a recorded flow. Until now a graph's only web reach was an HTTP request or a page snapshot on disk, so driving a real page cost an agent turn per action.

The engine is scoped to the run. A node does not borrow whichever engine a browser pane happened to bind, and it never takes over the page you have open in a conversation, so a scheduled run at 3am works with the pane closed and leaves your own browsing alone. The session closes when the run ends.

Authorization is enforced rather than degraded. A public domain has to be granted for the workspace, and where the pane would quietly fall back to the local browser, an unattended run refuses and says which host to grant. The check runs again on the page it actually landed on, so a redirect off the granted domain stops the flow instead of licensing whatever it reached. A form field can name a credential instead of a literal, and one that will not resolve fails loudly rather than typing an empty string into a password box.

Clicking, filling a form and replaying a flow are risk-gated, so a cron or webhook run containing one needs an approval node upstream. Running arbitrary JavaScript in a page is deliberately not offered.
