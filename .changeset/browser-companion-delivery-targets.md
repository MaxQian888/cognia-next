---
"cognia-next": minor
---

The browser side panel can now add a captured page to a task it already started, instead of only ever starting a new one. The Host declares where a submission may land — a new task, or any conversation this browser began — and the panel offers that list next to the workspace picker; picking a conversation appends to it rather than opening a second one, so following a page across three articles produces one task with three captures instead of three tasks.

The list is the Host's, which is what keeps the browser's authority unchanged: the extension picks a label and quotes back an id it was handed, and the Host resolves that id by looking it up in a catalogue it just built rather than by reading the id itself. An id that was not offered is refused the same way an unoffered workspace already was. Every conversation a browser can be offered is one it started — a second paired browser sees its own, and neither sees anything started on the desktop — and a conversation is only offered under the workspace it actually lives in, because appending does not move it.

An extension that predates this keeps working untouched: naming no target means a new task, which is the only thing a submission could have meant before.
