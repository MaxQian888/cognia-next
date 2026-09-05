---
"cognia-next": minor
---

Canvas collaboration now has a server to talk to. The collaboration plane gains Canvas routes (documents, an append-only Yjs update log, snapshots, comments, versions, presence, and a ticketed WebSocket), authorized by workspace role: a viewer reads, a member edits and comments, a maintainer deletes and compacts. On the client, the transport is reached through the existing collaboration client, so it shares the grant cache and the desktop proxy settings, and a fresh single-use ticket is minted for every connection attempt including reconnects. Share links now carry the real organisation rather than a placeholder that no server could have honoured. Off by default behind `COLLAB_CANVAS_ENABLED`.
