---
title: "0181 — What the user staged is what the model reads"
description: "Selections, results, earlier prompts and whole runs of messages all enter a conversation through the one staging path ADR-0157 built. The app's framing travels in a marked envelope the transcript can take back out, a derived answer is staged as an excerpt of its source, several messages fold into one chip, the phone gets the same actions, and a paired device asks the host for history it never synced."
---

# ADR 0181 — What the user staged is what the model reads

**Status:** Accepted
**Date:** 2026-09-15
**Related:** [ADR-0157](./0157-references-and-result-reuse) (the registry and staging path this builds on), [ADR-0093](./0093-selection-toolbar-content-hugging-window) (the system-wide selection toolbar whose actions and language list the in-chat capsule reuses), [ADR-0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version) (the command grammar the two new commands follow)

## Context

[ADR-0157](./0157-references-and-result-reuse) gave every `@` namespace one
registry and one staging path. An audit on 2026-09-14 of the ways a person
brings something into a conversation — selected text, a tool result, an
earlier prompt, several messages at once, a summary of any of those — found
that the path was sound and almost everything around it leaked.

**Staged context did not always arrive.** The hero composer built the
references block only when a session already existed, so chips staged before
the first message were cleared unsent. The same block, once sent, was
persisted into the user's message text with nothing to strip it: the bubble,
edit, quote, search, the instant title and `@msg:` itself all read
`Referenced context: …` as if the user had typed it. Web search results and
review receipts were prepended the same way (`User question:`). A reply-to
line reached the provider on the sidecar path but never the standalone BYOK
engine, which rebuilds history from saved messages.

**Selecting text in a conversation did nothing.** The desktop-wide selection
toolbar ([ADR-0093](./0093-selection-toolbar-content-hugging-window)) acts on
other applications. A passage selected inside a transcript could be copied and
nothing else.

**There was no way to act on several messages.** Reference, summarize and
save-as-memory were per message.

**The phone had none of it.** A long press opened an action sheet and also
selected a word under the finger, raising the system copy menu over the sheet.

**A paired device searched a fragment.** Companion sync pulls the recent end
of each conversation. `@msg:`, `@prompt:` and `^` searched the device's own
index, so the older history a person reaches for a reference to find was
mostly not there, and a record picked from somewhere else could not be staged.

Summaries had two defects of their own: the branch dialog fell back to a
structural digest without saying so whenever no BYOK key was set, and nothing
on that path passed the PII gate.

## Decision

### 1. The app's framing travels in a marked envelope

Everything the app prepends to a user turn — review receipts, the references
block, web results — goes into one envelope at the start of the text,
`<cognia_context_NONCE>` … `</cognia_context_NONCE>`
(`lib/chat/prompt-preamble.ts`). The nonce is random per turn, so a referenced
document that happens to contain a closing tag cannot end the block early.

The envelope **stays in the persisted text**. The standalone engine rebuilds
its history from saved messages, and moving the block into metadata only
would blind every BYOK turn after the first. Instead, every reader of user
text strips it (`stripPromptPreamble*`): the bubble, edit, quote, copy, search
projection, instant title, `@msg:`, `@prompt:`, memory backfill, exports,
rooms and the minimap among them. `metadata.promptPreamble` records only what
the envelope held (section kinds and reference titles, never bodies), and the
bubble renders it as a collapsed "N references attached" card.

The composer builds the envelope with or without a session, and citations
travel with the turn (`ComposerTurnMetadata`) instead of a per-conversation
store slot, so a hero-composer send keeps its chips. Staging the same record
twice replaces the earlier chip in place (`contextSelectionIdentity`). Reply
lines are rebuilt from `metadata.replyTo` in front of every provider message
(`withReplyContextLines`), which is what the standalone engine reads.

### 2. A passage selected in a conversation opens a capsule

A `selectionchange` inside the message list — mouse, keyboard or touch alike —
opens a small capsule beside the selection with **Reference**, **Ask in an
aside**, **Summarize**, **Explain** and **Translate**. A selection must be at
least three characters, or two when it contains Han, Kana or Hangul, where two
characters are a word.

**Reference** stages an ordinary `message` entity carrying an `excerpt`
(`derivation: "quote"`). **Ask in an aside** opens a workbench aside with the
passage quoted in its composer. The three generating actions stream into an
inline result panel; the answer can be copied or referenced.

### 3. A derived answer is an excerpt of its source, not new text

A summary, explanation or translation is staged as the same `message` entity
with `excerpt.derivation` set and `excerpt.quote` holding the original
selection. The prompt block says the text was generated by the app from what
the user selected, and names the messages, so the model never reads a
translation as the user's words or an app summary as a quotation.

Freshness is checked against the source, not the answer: a staged excerpt is
**current** while its quote still appears in the messages, **changed** when it
does not, and **gone** when a message is. Re-running the model to find out
would cost a turn and could not answer the question anyway.

Generation uses the user's own model when one is configured and the
headless-turn client otherwise (`buildAgentBackedLlmClient`). Material larger
than one pass is summarized in parts and combined
(`lib/ai/generation/summarize-material.ts`, 24 000 characters a part). Every
part passes `hasNoLeakingPii` before any call. With no model at all the panel
says so; nothing falls back to a digest silently.

### 4. `@prompt:` is the user's own words

A separate namespace from `@msg:` because what people do with an old prompt is
about the words: cite them, or send them again. A row counts only when
`resolveMessageSpeaker` finds nobody behind a `user` message, since IM
connectors and shared sessions store other people's messages under that role.
The body is the typed text with the envelope removed. A candidate carries
`insertText`, so ⌥↵ (or the row's insert button) puts the words back in the
draft and stages nothing.

### 5. Several messages are one mode and one chip

"Select messages" (a message action, or a row checkbox) turns the list into a
selection mode. A click ticks; Shift extends; ⌘A selects all; Esc, the Done
button, unticking the last message and Android back all leave. The mode is
offered only inside a list that mounts it (`TranscriptSelectionHostContext`),
so read-only transcripts rendering the same message component never show the
action.

A floating bar offers **Reference**, **Summarize**, **Copy** and **Save as
memory**. Reference builds **one** combined chip in transcript order, with
duplicates dropped and each member clamped on its own; the chip lists its
members and any one can be removed. A single readable message degrades to an
ordinary message reference, identical to picking it with `@msg:`. Summarize
hands the messages over as separate segments, so a part ends between two
messages unless one message alone is longer than a part.
Save as memory writes **one** memory with each passage labelled by its
speaker; a passage from a third party files the draft as `external_agent`,
which the memory layer treats as untrusted.

### 6. The phone gets the same actions

The long-press sheet gains **Select messages**, entering the same mode, and
**Select text**, which opens the message in a sheet whose text can be selected,
with Reference, Summarize, Explain and Translate below it. With nothing
selected those act on the whole message. The long-press surface no longer
selects a word. There is no aside on the phone: it opens in the desktop
workbench dock, which the phone shell does not have.

Both the desktop capsule and the phone sheet run through one hook
(`useMessageSelectionActions`), so a passage referenced on either is the same
chip.

### 7. A paired device asks the host for history

A companion device routes `@msg:`, `@prompt:` and `^` to the host through two
read commands over the desktop-write bridge, answered by the same local reads
the host's own composer runs (`localHistoryReference`):

- `session_reference_search` — one kind's candidates for a query, with the
  composer's workspace and conversation.
- `session_reference_snapshot` — records by id: always their fingerprints, and
  their bodies on request. A staleness check for a twelve-message chip is one
  round trip.

Routing keys on the host profile (`mobile-companion` or `cloud-companion`),
not on `!isTauri()`: a standalone browser's own database is its history, and
the headless brain is the host. When the host cannot answer, search falls back
to the device's copy and the picker says the list is partial. A body falls
back only when the copy has the record, because "missing here" is not
"deleted". A fingerprint never falls back: the copy's digest is not the host's,
so the check fails and the chip stays as it was.

## Divergences from the plan

- The two commands were planned as `chat_reference_search` and
  `chat_reference_snapshot`. The contract generator files every command into a
  host category by name prefix and `chat_` belongs to none, so they are
  `session_reference_*` under the new resource `session.reference`.
- `@prompt:` shipped after the remote plan was written; it routes to the host
  with `@msg:` and `^` because it reads the same history.
- The multi-select bar gained **Copy**, which the plan did not list.

## Consequences

- The persisted user text is no longer the typed text. Any new reader of
  message text must go through `stripPromptPreamble*` or `extractText`; a
  reader that does not shows the envelope to the user again.
- A staged excerpt can be **changed** without its source being edited in a way
  that matters (a reflowed paragraph that still reads the same passes, a
  reworded one does not). That is the honest reading of "is this still what
  was said".
- Two more companion commands are part of the contract. A host that predates
  them refuses the call, which the device treats like any other failure: a
  partial list, said so.
- The phone's selection sheet shows the typed words of a user message. A part
  that renders as text but is not typed (a video's description block, once
  that lands) would need to be excluded there as it is from edit and quote.

## Alternatives considered

**Move the references block out of the text into metadata only.** Rejected:
the standalone engine rebuilds history from saved messages, so every BYOK turn
after the first would lose its context.

**Re-run the action to check a derived excerpt for staleness.** Rejected: it
costs a model call per check and a new answer differing from the old one says
nothing about whether the source changed.

**Sync all history to paired devices.** Rejected: the recent-end sync is a
deliberate bound on what a phone downloads, and a reference is exactly the
case where asking the host once beats storing everything everywhere.

**One chip per selected message.** Rejected: twelve chips for one intent, and
removing "the selection" would take twelve clicks.

## Implementation

Correctness: `71398c31d`, `c3c449512` — `lib/chat/prompt-preamble.ts`,
`components/chat/message-parts/prompt-preamble-card.tsx`,
`lib/chat/turn-metadata.ts`, `lib/chat/mentions/{selection-citations,selection-identity}.ts`,
`lib/chat/reply-to.ts`, `lib/ai/generation/summarize-material.ts`,
`lib/chat/search/indexer.ts`.

Capsule and `@prompt:`: `9eca81ea6`, `a768baf79` —
`components/chat/message-selection-toolbar.tsx`,
`components/chat/message-selection-result-panel.tsx`,
`lib/chat/selection/{selection-text,message-excerpt,run-selection-action}.ts`,
`hooks/chat/use-selection-action-run.ts`, `lib/chat/mentions/prompt-reference.ts`.

Several messages: `bd8e831a8` — `hooks/chat/use-transcript-selection.ts`,
`components/chat/transcript-selection-bar.tsx`,
`lib/chat/selection/{message-set-reference,transcript-selection}.ts`,
`lib/chat/save-message-as-memory.ts`.

Phone: `ae86c7814` — `components/mobile/chat/{message-action-sheet,message-text-selection-sheet}.tsx`,
`hooks/chat/use-message-selection-actions.ts`,
`components/chat/floating-action-bar.tsx`, `hooks/ui/use-back-dismiss.ts`.

Paired devices: `80ac1665f` — `lib/chat/mentions/{host-references,host-reference-rpc}.ts`,
`lib/chat/mentions/entity-sources.ts`, `lib/companion/desktop-write-source.ts`,
`protocol/companion-commands.json`, `src-tauri/src/companion_api/rpc/data_sync.rs`.

Not verified at acceptance: a streamed answer from a real model (the
development shell had none), the phone flow in the Capacitor shell, and a
reference search against a real paired host.
