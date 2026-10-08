---
"cognia-next": minor
---

Device and environment management are reorganized. A device's details are now one frameless record instead of a grid of cards, and on a phone they open as a full-screen page that the back gesture closes. The phone's device list also gains "Add SSH host" and the sync-approval notice. Environments are a list with an editor beside it. The editor warns before unsaved edits are lost, asks before deleting, and says when the repository's approved setup replaces the local one. A changed `.cognia/workspace.json` is now reviewed as a list of what changed since you approved it. A device that cannot read the folder says so, instead of reporting the repository as broken or claiming there is nothing to suggest. A workspace with no folder now explains what to do, and the image catalog is a single page instead of six stacked cards.
