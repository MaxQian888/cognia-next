---
"cognia-next": minor
---

Conversation list: saved views, one search-reach control, and a list that holds still while you read it.

**Views replace filter presets.** A saved view pins any of four things — quick filters, sort order, grouping axis, search reach — and leaves the rest following whatever you set later, so "unread first" no longer throws away the grouping you chose. Your existing presets are already views (ones that pin only their filters); nothing to migrate. The chip says "name · modified" the moment a pinned part drifts, with one click to reset and one to update the view. Three built-ins ship with the app: Unread, Recently created, Search everything. Views follow your profile across devices; which one you are in stays per device.

**Search reach is one control instead of three unrelated ones.** Whether the sidebar could find a conversation used to depend on the archived-view toggle, on your _grouping_ choice, and on a settings switch. A control beside the search field now owns all three — this workspace or all of them, include archived, search message content — and a view can carry them. Including archived applies only while you are searching, so browsing archived chats stays the view toggle's job. Results mark where they came from.

**Search matches what ⌘K matches.** The sidebar now uses the same ranker, so "dply" finds "deploy" and both surfaces order the same query the same way. Neither list claims "no results" while the message index is still answering, and a one-character query says it is too short instead of silently searching titles only.

**Dates follow the sort you picked.** Sorting by date created now buckets by creation time and says so in the headers; oldest-first reverses the headers along with the rows; and sorting by title or unread — which have no date axis — renders one flat list rather than headers that do not explain it. Grouping by team is a real grouping now, on phone as well as desktop, with the team rail jumping to a section instead of quietly filtering the list.

**The list stops moving under your cursor.** While the pointer is over the list, or it is scrolled, rows keep the order and the section they were in; a pill says how many updates are waiting and applies them at once. New conversations still appear immediately, and deleted ones still disappear. Very long flat lists (a search across every workspace, an alphabetical sort) now render only what is on screen.

Also fixed: an archived-view filter chip showing a raw folder id, the "showing N of M" count including rows inside collapsed groups, and the mobile ungrouped section header rendering its own translation key. Settings → Conversation keeps the options that decide how a row looks and hands grouping, sort and search reach to the list's own toolbar.
