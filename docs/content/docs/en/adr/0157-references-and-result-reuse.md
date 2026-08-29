---
title: "0157 — References and result reuse"
description: "One registry behind every @ namespace and the ^ shortcut, message- and result-level granularity on top of the existing chat index, snapshots that admit when they are stale, and citations read back as backlinks."
---

# ADR 0157 — References and result reuse

**Status:** Accepted
**Date:** 2026-08-29
**Related:** [ADR-0094](./0094-conversation-anchors-and-jump), [ADR-0099](./0099-chat-history-search), [ADR-0100](./0100-unified-template-platform), [ADR-0129](./0129-unified-global-search), [ADR-0134](./0134-remote-document-providers)

## Context

The composer's `@` menu grew a first-party record layer without an ADR: five
namespaces (`@memory:`, `@issue:`, `@plan:`, `@chat:`, `@artifact:`) behind a
registry copied from [ADR-0134](./0134-remote-document-providers)'s document
providers. It worked, and the reasoning for it lived in source comments.

Then the shape of what was missing became clear from three directions at once.

**The granularity stopped one level too high.** `@chat:` references a whole
conversation — its last forty turns — and can only *find* that conversation by
matching its **title**. Meanwhile [ADR-0099](./0099-chat-history-search) had
been serving content search across every message since it shipped, and
[ADR-0129](./0129-unified-global-search) exposed it in ⌘K. The composer used
none of it. A person remembers a conversation by what was said in it, not by
what it was called.

**The one thing you cannot reference is the thing you want.** The search
projection drops tool **outputs** on purpose (`lib/chat/search/project-text.ts`
says why: a file read is tens of KB and would bury real prose in a corpus that
has to stay resident). `@chat:` inherits that, since its transcript snapshot
goes through the same projection. So the output of a turn — the file that was
read, the command that ran, the page that was fetched — was neither searchable
nor referenceable anywhere in the app. "Use the thing that came out of the other
chat" had no expression.

**Citations were write-only.** `metadata.mentions` is written on every citing
user message, and its type docs call it "the only record that the turn cited
that document". One reader existed — the search projection folds the labels in
so a chip-style pick is findable at all. Nothing read it the other way, so the
app could answer "what did this message reference" and never "what referenced
this record".

Two smaller defects fell out of the same area. `@chat:` never applied
`filterExposedSessions`, so it offered subagent inner transcripts and workbench
asides as referenceable conversations. And every source read its whole store on
each keystroke past the debounce — `listSessions()` pulls every full session row
— which is precisely the read `lib/chat/search/engine.ts` names as "the same
mistake the old content search made".

## Decision

### One registry, two doors

A reference is a registry entry, not a feature. Adding a namespace is a
`registerEntityMentionSource` call: the pure trigger detector, the popover, the
pick handler, the staging path, the chip and the prompt formatter all read the
registry. Three exhaustiveness tables (`ENTITY_ROW_ICONS`, `ENTITY_NOUNS`,
`UNTRUSTED_ENTITY_KINDS`) fail the build until a new kind is considered in each.

The registry also owns the **trigger characters**. A source may declare a
one-character `shortcut`; `^` is the first, and it opens the result picker with
no namespace to type. It is a second *door* onto one source, not a second
mechanism: detection returns an ordinary namespaced entity trigger, so nothing
downstream has a shortcut branch. `isMentionStart` generalised to
`isTriggerStart` so `2^3` and `git rev-parse HEAD^` answer the boundary question
with the code that already keeps `user@host` from being a mention. Reserved
characters (`@`, `!`, `#`, `/`) and duplicate claims throw at registration.

### Two new granularities, on indexes rather than scans

`@msg:` is the first consumer in the composer of the ADR-0099 engine: candidates
are found by message **content** across every conversation, ranked and snippeted
exactly as the same hit is in ⌘K. Its identity is `<sessionId>#<messageId>` —
the session half is not redundant, because the chip's link, the permalink in the
prompt and the backlink index all need the owning conversation without a second
lookup. A staged message reference can be widened to the turns around it, which
is the same question `range` answers for an artifact or a file selection.

`@result:` and `^` run on a new derived table, `chatResultIndex` — one lean row
per tool result holding what ran, what it was about, the output's true size and
a clamped excerpt. A **handle**, never the output.

Artifacts and canvas documents are deliberately **not** indexed. Their message
parts carry a pointer (an `artifactId` plus a title snapshot) while the body
lives in a store `@artifact:` already reads live; a row here would put one
document behind two doors with two bodies, and the stale one would be the one
inlined into a prompt.

### One walk, three derived tables

Reading `messages` with their `parts` is the expensive half of indexing — a
backfill batch is 500 whole rows. `chatResultIndex` and `mentionLinks` ride the
walk that is already paying for it rather than opening two more. One walk has
one cursor, which is why each schema bump rewinds `chatSearchState`: on an
install whose backfill had already finished, leaving it complete would mean the
new indexes never built. Re-projecting search text is idempotent and runs at
idle, so the cost is a repeated walk, not a wrong index.

All three reconcile per session rather than appending, for the same reason: an
edited or truncated turn **removes** messages and citations.

### Snapshots stay frozen and say when they are stale

A staged reference is a snapshot — what was read in the picker is what the model
gets, and it is the only version a chip can show synchronously. But the record
can move underneath it. Refreshing silently at send would be the worse failure:
the user would have approved one body and sent another.

So the body is never rewritten and the **divergence** is reported on both sides.
Every source declares an opaque `fingerprint` — only the source knows what
"changed" means for its record, and the only question asked is whether two
strings still match. The chip grows a badge and a one-click re-read; the prompt
block gains a line naming the capture time. A kind that declares no fingerprint,
and a chip staged before fingerprints existed, are left alone: un-checkable is
not the same as changed, and reporting it as stale would train people to ignore
the badge.

### Citations read backwards

`mentionLinks` is derived from `metadata.mentions` — no new write path. A
conversation's header carries a self-hiding "Referenced by N conversations"
chip beside the branch and import ones; a memory or an issue gets the same list
inline, where "is anything using this" decides whether the record still earns
its place. Rows land on the exact citing turn.

The legacy text fallback in `getMessageMentions` is deliberately **not** used
here: `resolveMentions` types every unresolvable token as a **file**, so
re-parsing prose would fill the file backlinks with things that were never
files, while recovering none of the entity citations the panels query — a
chip-style pick leaves no token in the text to recover.

### ⌘K hands over rather than only navigating

A referenceable row gains a second action (an `@` control, or `⌘↵` on the
highlighted row). It is a **translation**, not a second staging path: the row
becomes the same `EntityMentionCandidate` the `@` panel produces and goes
through the same staging hook, so a reference made in either place is
byte-identical. `⌘↵` is consumed even over an unreferenceable row — a modifier
that means "reference" on some rows and "open" on others is worse than one that
does nothing on the rest.

### Untrusted content follows authorship, not storage

`issue`, `session`, `message`, `result` and `memory` are wrapped. A tool output
is by definition text this app did not write — a file it read, a page it
fetched, a command's stdout — which makes it the likeliest carrier of an
instruction aimed at the model. `plan` and `artifact` stay unwrapped: both are
authored here as work to be continued, and a plan prefixed with a
do-not-follow notice is worse than no plan.

## Consequences

- Adding a reference kind is one registration plus three table entries the
  compiler names. Adding a trigger character is one field on that registration.
- Three derived tables share one walk and one cursor. Each is rebuildable and
  none is a source of truth, which is what makes the rewind-on-upgrade safe.
- The composer's `@` panel reads each store once per picking session
  (`lib/global-search/cache.ts`, keyed per workspace and conversation) instead
  of once per keystroke.
- A staged reference can now be **wrong but honest** rather than silently
  stale. Callers must render `stale`; a surface that ignores it re-opens the
  defect.
- `@result:` is limited to tool outputs. A second `ChatResultKind` must arrive
  with a body this index can actually be the source of.
- Pre-ContextRef messages have no backlinks. That is the honest answer, and the
  alternative was a noisy one.

## Alternatives considered

**Widen the search projection to include tool outputs.** Rejected: it would bury
prose under tool logs in a corpus that must stay resident, and the two questions
("what was said" and "what came out") want opposite things from the same parts.
Two projections, one walk.

**Re-read staged references at send time.** Rejected: the user approved a body,
and sending a different one is a worse failure than sending a stale one that
says so.

**Index artifacts and canvas documents as results.** Rejected: their parts are
pointers and their bodies live in stores that `@artifact:` already reads live.

**A `*grams` prefilter for the result index.** Not needed. The picker is an
index walk with a limit, and the search path stops as soon as its page is full;
[ADR-0099](./0099-chat-history-search)'s phase B remains unclaimed.
