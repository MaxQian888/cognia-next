---
title: "0240 — A generated surface streams, answers back and computes"
description: "Cognia's A2UI already had 68 components, incremental surface updates, data binding and IM projection, but a model-written chat surface scrolled past as raw JSON while it streamed, vanished when its JSON was invalid, could not reach the agent when a button was pressed in desktop or web chat, could not declare a derived value, and passed its URLs through unchecked. This ADR keeps the existing A2UI store and renderer and closes those five gaps: an inert streaming preview, a source fallback, gesture actions routed to the rendering session, a closed JSON expression language for computed values, and one URL policy shared with untrusted chat Markdown."
---

# ADR 0240 — A generated surface streams, answers back and computes

**Status:** Accepted
**Date:** 2026-10-24
**Related:** [ADR-0025](./0025-a2ui-im-bridge) (A2UI ⇄ IM bridge), [ADR-0218](./0218-chat-reading-surface-links-blocks-and-charts) (streaming fence renderers), [ADR-0236](./0236-built-in-prompts-are-owned-slots-behind-one-prompt-center) (the inspect-only A2UI protocol prompt)
**Evidence:** `docs/evidence/2026-10-24-a2ui-adaptive-ui-gaps.md`, `docs/research/2026-10-20-a2ui-strengthening-audit.md`

## Context

A comparison with ChatGPT-style adaptive UI asked what Cognia's A2UI lacks. The component count was not the gap: the catalog has 68 types, the store upserts components by id, the data model binds through JSON Pointers, and surfaces project into IM cards. The 2026-10-20 audit had already chosen to strengthen this implementation rather than replace it with OpenUI. A source check on 2026-10-24 found five real gaps in the path from model output to a live, two-way surface.

1. **Streaming showed raw JSON.** Streamdown's streaming renderers covered only `mermaid` and `chart`. An ` ```a2ui ` fence streamed as a code block, and the adapter split it into an `a2ui` part only when the turn sealed.
2. **A bad fence disappeared.** When the payload produced no surface, `A2UIPart` returned `null`. There was no placeholder and no source.
3. **Desktop and web chat buttons never reached the agent.** IM callbacks start a turn (`connector-callback-handler.ts`) and the TUI sends `formatActionForAI` to its agent. In the GUI chat, `renderPart` mounted `A2UIPart` without a handler, and the built-in actions provider passed no `onAction`. The fall-through in `action-handlers.ts` (default branch, `submit`, `execute`) dropped every action the mini-app handlers did not own. The MCP tool text claimed the agent "receives this as a userAction event on the next turn". Nothing did that.
4. **Computed values could not be declared.** `resolveComputedFields` and `computedHelpers` existed in `data-model.ts`, but they had no caller. A `ComputedField` holds a JavaScript closure, so a model has no way to express one, and the protocol had no field for it.
5. **URLs were unchecked.** `Link` and `Breadcrumb` rendered a model-written `href` directly. `Image`, `Avatar` and `Card` loaded any `src`. The academic results opened `pdfUrl` with `window.open`. Chat Markdown already had an untrusted-URL policy, and `ExternalLink` documented that A2UI should reuse it, but none of these components did.

## Decision

Keep the existing store, renderer, persistence, editor and IM projection. Add the following.

### A streaming preview, separate from the sealed surface

A streaming renderer for `a2ui` fences (`components/chat/renderers/a2ui-streaming-fence.tsx`) parses the prefix written so far (`lib/a2ui/streaming-preview.ts`). The parse follows these rules:

- **No scalar is ever truncated.** `completePartialJson` cuts back to the last structurally complete value and closes the brackets still open at that point. A half-written string, number or key is never shown. An object may arrive with a subset of its keys, so a component gains props as they stream. A component that has not yet named its `id` and `component` is held back.
- **A preview only draws.** Only `createSurface`, `updateComponents`, `dataModelUpdate` and `surfaceReady` pass through. All of them are retargeted to a reserved id prefix (`a2ui-preview:`) and forced to `inline`.
- **An unfinished prefix only adds.** A computed declaration waits for the complete fence, because a half-streamed operand list computes the wrong value. A data update merges until the fence is complete, because its `merge` key may not have arrived yet.
- **The preview is inert and temporary.** It renders read-only inside an `inert` wrapper, and parsing is throttled to once every 120 ms. It is deleted when the sealed `a2ui` part replaces it. It is never persisted, because inline surfaces never are. Plugin surface-create and surface-destroy hooks skip the prefix, and the parser and the MCP dispatch listener refuse it in anything a model writes.
- **The preview is bounded.** A prefix nested deeper than 64 levels is not previewed, so a pathological fence costs nothing on each throttled parse.

When the payload yields no surface, `A2UIPart` shows the fence source with a notice instead of rendering nothing.

### Gesture actions answer back to the rendering session

`lib/a2ui/chat-action-routing.ts` is the fall-through the built-in actions provider installs as `onAction`. It sends an action as the session's next user message, through the existing `sendChatMessage` bridge, only when all of these hold:

- the surface is bound to a session. A chat-rendered surface (an `a2ui` part, a fence in finalized Markdown, or a tool result that carries A2UI) binds to the session of the transcript list that renders it (`TranscriptSessionProvider`), not to the focused session, which a split pane, side chat or builder transcript is not. Outside a list it falls back to the row's own session, then to the chat scope. When the same surface id is rendered in several places, the newest live render owns its clicks, and releasing that render hands them back to the previous one. Mini Apps, the editor, previews and galleries are never bound.
- the component is a deliberate gesture: `Button`, `FormGroup` or `Link`. Tables, charts, pagination, tabs and data changes never route. Their state arrives in the data snapshot of the next gesture.
- the action is not a connector replay (the IM path owns those), and it is not the same gesture repeated within 1.5 s.

The built-in mini-app action names (`A2UI_LOCAL_ACTION_NAMES`), including the keypad, timer-preset and tracker names that carry digits, stay local. A test pins that list against the handler's `switch`. `refresh` and `refresh_data` had only logged, so they now forward too.

The message leads with the control's label, capped at 200 characters. An `a2ui-action` fence follows, holding the surface id, the component id and type, the action name, its data, and the surface's data model. The data (a form's values) and the data model are each capped at 8000 bytes; a larger one is replaced by its size. A running turn steers or queues the message, as it would for typed text. A failed send shows a toast.

### Computed values are a closed JSON expression language

A surface declares `computed: { "<pointer>": { op, args } }`. It can appear on `createSurface`, on a simplified payload, and on `dataModelUpdate`, where `null` removes a declaration. Operands are literals, `{ path }`, or nested expressions.

**Operators.** The set is closed at 30 operators:

- arithmetic: `add`, `subtract`, `multiply`, `divide`, `mod`, `pow`, `min`, `max`, `abs`, `round`, `floor`, `ceil`;
- aggregation: `sum`, `sumOf`, `count`, `countWhere`, `percentage`;
- formatting: `concat`, `currency`, `fixed`;
- logic: `if`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`.

**Evaluation** (`lib/a2ui/computed.ts`):

- Each declaration compiles into a `ComputedField` and runs through the existing `resolveComputedFields`, so the helpers that used to be unreachable are now the execution path.
- Bounds are checked before a declaration is accepted: 64 fields, depth 8, 32 arguments, 256 nodes.
- A map must be well ordered: a declaration may read plain data and the targets declared before it, never its own target, a later one, or one that contains or sits inside either. Otherwise the previous result would feed back in and the value would drift on every keystroke. An update whose merged map breaks the rule is dropped.
- Evaluation is one ordered pass, so it always terminates and settles. `concat` returns `null` instead of a string longer than 10,000 characters, so a chain of declarations cannot multiply a string's length. Nothing is evaluated as code.
- Text-field strings count as numbers and an empty field counts as 0. A non-finite result becomes `null`.

**Where it applies.** The store recomputes after every data mutation. The declaration travels through every serialization site: the Dexie surface row, saved apps, import and export, capture (`run-and-capture`), the `segmentToMessages` replay, and the IM card projection, which carries the values as of the reply. Each of those sites validates the declaration again, and each refuses a message (or MCP call) whose map is invalid, as the store does, rather than keeping the rest without it. The MCP `a2ui_create_surface` and `a2ui_data_model_update` tools accept the same map, in both the renderer and sidecar copies, and a parity test keeps the copies aligned.

Outside the desktop renderer, the headless brain feeds MCP dispatches into the same store, so it computes as the desktop does. A captured surface reaches `cognia serve` and SDK clients as an `a2ui` content part whose payload carries the declarations with their values applied. The CLI TUI validates the declarations when the part arrives (an invalid map refuses the surface, as the store does), keeps them through `/view`, and its overlay writes each edit to the path its control binds and recomputes, so a total follows the quantity being typed.

### One URL policy

`lib/a2ui/url-policy.ts` mirrors `untrustedMarkdownUrlTransform`, and a test pins the two together.

- **Links:** `http:`, `https:` and `mailto:`. Control characters are stripped before the scheme is read, so `java\tscript:` is rejected. A web link comes back in the URL parser's canonical form, so `https:evil.com` or `https:\\evil.com` becomes `https://evil.com/`, which `ExternalLink` recognises and keeps out of the app window.
- **Media:** `http:`, `https:`, `data:image/`, `blob:` and root-relative assets.
- **Inline style:** the renderer passes every component's `style` through `safeA2UIStyle` before the component sees it. A property whose `url(...)` target the media policy rejects is dropped, and so is one using `image-set()`, `src()`, `expression()`, a CSS escape, an unclosed `url(`, or a script-bearing property (`behavior`, `-moz-binding`).

Web links open through `ExternalLink`, or through `openExternal` for the academic PDF. A rejected link renders as text, or as its action button. A rejected image falls back. A Breadcrumb's `navigate` action carries a web link or a scheme-less in-surface route, never a rejected scheme.

The A2UI `Markdown` component keeps the assistant's own chat Markdown policy, since the same model writes both, and A2UI from an IM sender never renders as a surface.

### The protocol prompt says so

The inspect-only A2UI prompt moves to `contractVersion: 2`. It now teaches four things:

- the action round trip, including the local action names;
- the computed language, listing every operator;
- the link and image policy;
- one chart rule. A display-only chart or table follows the visual-output routing, an A2UI `Chart` or `Table` belongs inside a surface that has controls, and RichOutput covers the advanced profiles.

The MCP description of `a2ui_handle_connector_action` now states what the tool actually does.

## Consequences

- A generated interface assembles in place while the turn streams, and a broken one shows its source.
- A button in desktop or web chat behaves as it does in IM: it becomes the user's next message. This is an ordinary user message, so it gets what typed text gets: the send guard (`scanSendGuard`) and privacy-mode redaction in `dispatchTurn`, plus steering and queueing. It needs a user gesture, a session-bound surface and an allowlisted component type.
- Calculators, cart totals and conditional labels work without another agent turn.
- A URL in a Link, Breadcrumb, Image, Avatar, Card, academic PDF or inline `style` cannot navigate the app window, run script, or load a local file.
- The preview does not deduplicate against the sealed surface. When the turn seals, the preview is replaced, which is visible as one re-layout.

## Not decided here

These remain open:

- Official A2UI v0.9.1 interop (audit batch C).
- JSON-Schema contracts for all 68 types.
- Feeding validation failures back to the model. The sidecar tools still return `ok: true`.
- The A2UI `Markdown` component follows the assistant's chat Markdown policy rather than the A2UI URL policy; whether plugin- or external-agent-authored Markdown needs an untrusted mode is open.
- A send that the chat controller rejects after accepting it (send guard, concurrency cap) shows the controller's error, not the A2UI toast.
- An evaluation harness for generated layouts.
- Turning A2UI on by default.

The ledger tracks each of these as a residual.

## Verification

Unit and component tests cover:

- the partial-JSON completer, including a no-truncated-scalar sweep;
- the preview lifecycle and throttling;
- the source fallback;
- the session binding (transcript session, newest live render) and the router rules;
- the provider wiring;
- the local action-name pin;
- every computed operator, its limits, order and identity, the well-ordered rule and the `concat` cap;
- computed round trips through the store, Dexie hydration, import, capture, IM projection, app save and export, the headless content part, and the CLI TUI (validation, `/view`, live recompute in the overlay);
- MCP schema parity and dispatch forwarding;
- the URL policy, its parity with chat Markdown, and the inline `style` sanitizer on both render paths;
- the Link, Breadcrumb, Image, Avatar, Card and PDF behavior.

A run with a real model in the desktop shell is tracked in the evidence ledger.
