---
title: "0164: Templates, squads and commands are portable and iterable"
description: "A squad remembers the template it came from, a chat template is a first-class portable artifact, a plugin can iterate the templates and commands it owns, and sharing has three tiers (link, signed package, trusted publisher) built on the platform that already existed."
---

# ADR 0164: Templates, squads and commands are portable and iterable

**Status:** Accepted  
**Date:** 2026-09-02  
**Builds on:** [ADR-0100](./0100-unified-template-platform), [ADR-0140](./0140-squad-as-an-executor), [ADR-0037](./0037-public-share-links), [ADR-0155](./0155-plugins-reach-the-host-through-one-door), [ADR-0027](./0027-mobile-sync-orchestrator)

## Context

An audit of the template platform, the Squad surfaces, the chat-template feature, the plugin API and the share pipeline found that most of the lifecycle ADR-0100 advertises was already wired, and that the remaining gaps shared one shape: a capability existed on one surface and was absent on the surface a user would actually reach for it.

- The Settings gallery created a Squad straight through the store, so a Squad had no `TemplateInstanceRecord`. It could never be updated from, or detached from, the template it came from. Save-as-template mirrored only a draft, which no package could carry.
- Chat templates were the one authoring resource with no way off the device. Not in the backup, not synced, no file format, invisible to the catalog. A phone's `/` menu never saw a template saved on the desktop.
- A plugin could create a template draft once and register immutable releases. It could not save, publish, fork, deprecate or export anything, while `ctx.team.saveAsTemplate` reached `saveDraft` with a weaker permission and no consent prompt. A plugin could declare slash commands only in its manifest, and custom `.md` commands were desktop-only behind a bare `isTauri()`.
- Share links carried a character, a skill, a character team or a workflow template into a read-only page. Every exported package was unsigned because nothing ever produced a signature, so the `verified-publisher` tier was unreachable for templates.
- The phone had a complete template catalogue that nothing linked to, and three routes whose bodies collapsed to a blank strip under the mobile shell wrapper.

## Decision

1. **A Squad created from a template keeps its lineage.** The gallery's Use runs the platform's preflight and instantiate, so the Squad gets an instance record, and the Squad detail panel renders the same instance card the Studio uses, extended with a title and summary rather than forked. Update and detach work from Settings. Save-as-template can publish a version, and the templates panel shows platform status with Publish, Export package, Fork, Import package and Share beside each user row.

2. **A chat template is a catalog-only domain and a portable file.** Its writer stays `lib/db/chat-templates.ts`, the catalog only projects it, re-projecting on every write through a subscription because templates are saved from the composer one keystroke away from the surface that lists them. The portable form is the same frontmatter markdown the repository reader already parses. Export is written undemoted, and the reader is what takes capability away from a file whose author you did not choose. The table joins the companion sync with tombstones, the backup and the per-domain transfer, with content class `encrypted-content`.

3. **A plugin iterates what it owns.** `ctx.templates` gains `saveDraft`, `publish`, `fork`, `deprecate`, `deleteDraft`, `exportPackage` and `importPackage`, all behind `templates:library:write`, the same consent broker `createDraft` uses, and an ownership check on `provenance.pluginId`. Provenance is outside the content hash, so stamping it changes nothing a package verifies. `ctx.team.saveAsTemplate` asks for both permissions. `ctx.commands` registers slash commands at runtime, namespaced like the manifest path and first-wins across plugins, and reads and writes custom `.md` commands behind `commands:read` and `commands:write`. `onCommand` dispatches to the owning plugin first. The desktop scanner reads `.cognia/commands` as the CLI already did. Project-scope commands travel over the workspace file transport a paired browser or phone already has, the global scope stays host-only and says so.

4. **Sharing has three tiers on the existing pipeline.** Two share kinds: `template-definition` carries a published release, hash-verifiable on the far side with the sharer's local provenance neutralised, and `chat-template` carries a body, parameters and a launch spec demoted on the way out and again on the way in. Inside the app the viewer offers Add to my library through the same package import path that resolves trust and stamps provenance. A publisher identity is an Ed25519 key in the host-neutral keyring store, fingerprinted the way the plugin installer fingerprints, so a template publisher and a plugin publisher are one row in the trust ledger. Exports sign by default once a key exists, imports can trust a signer, and packages import from a URL behind the egress guard.

5. **The phone can find what it already had.** `/templates` joins the home quick actions, the Me list and the Discover tab prefix. `/templates`, `/discover` and `/agent-runs` are full-viewport routes, and the coverage test only accepts an exemption for a body that sizes itself. A `/me/chat-templates` page reuses the settings section with a `mobile` prop.

## Consequences

- The Studio's scope control, the boot backfill of instance workspaces, the controlled tabs and the URL-driven selection close the last uncalled service methods in `lib/templates/service.ts`. The dormancy test still pins the three corners that stay inert on purpose.
- The first publish of a squad template is 0.1.0, because `service.publish` refuses a bump that differs from `getPublishSuggestion`. Changing that is a platform decision, not a squad one.
- Chat templates saved by the companion sync bypass the table's writers, so the sync handler announces applied rows itself and the composer subscribes. A pull that applied nothing stays silent.
- The share viewer decides whether it is the app's copy of the page by native shell OR origin different from the share endpoint, failing closed, and never by `isTauri()` alone, because the browser is a first-class shell here.
- `ctx.commands` and `ctx.templates` are exposed to frontend, hybrid and python plugins. The host-request router needed no route of its own, opening the namespaces in the catalog was enough, and callback-taking methods stay refused by name. A python plugin declares its commands in `manifest.commands`, and the commands bridge (`lib/plugin/bridge/commands-bridge.ts`) hands its `@hook("onCommand")` one structured invocation on the owner-first dispatch path.
- Deferred on purpose: nothing from the original list remains. The shared board has since shipped: `/issues` and the Squad task board render through one `components/board/kanban-board.tsx` primitive (columns, drag, collapse, empty states, keyboard movement), and the two link to each other, an issue card dispatched to a Squad carrying a squad chip and the Squad board carrying a chip back to its originating issue. `verified-fresh-agent` has since shipped: the chat controller arms `lib/agent/composition/verified-fresh-agent.ts` before a direct turn, and when the turn settles a new session with none of the main turn's memory, twin or tool history verifies the request, the final reply and the working-tree diff, leaving a `verification-verdict` part that opens the reviewer's session, visible but disabled with a reason on companion shells. The agent-facing tools shipped as host-routed built-ins on the plugin-tool relay (`lib/claude/template-builtin-tools.ts`, opt-in via `selfInvokeTools.templates` under Settings > Tools): `template_list` / `template_get` / `template_instantiate`, `chat_template_list` / `chat_template_get` and `squad_list` / `squad_apply_template` / `squad_save_as_template`, where every write asks the same plugin consent broker `ctx.templates` answers to. The backup share link now runs through `lib/share/backup-share-gate.ts`: a plaintext package is scanned with `@cognia/redact` and the owner sees a per-area hit report and must tick a confirmation before the link exists, an encrypted envelope passes through labelled as unscannable, a clean package links straight away with a one-line note, and nothing is ever redacted because a redacted backup does not restore faithfully. The `agentTeamsWorkspace` namespace is now split per top-level section under `i18n/messages/<locale>/agentTeamsWorkspace/` with the stray scalar leaves in `_root.json`, and no key or call site changed.

## Amends

- **ADR-0100**: the catalog gains a seventh catalog-only domain, `chatTemplate`, and the plugin seam widens from create-only to the owned lifecycle.
- **ADR-0140**: the dead workspace UI-state cluster in the store is removed. `activeTeamId`, `displayMode` and `workspaceTab` stay because persist still carries them, labelled inert at the type and pinned by a test.
- **ADR-0037**: two new share kinds and the first in-app import action on the viewer.
- **ADR-0155**: a new capability module, `commands`, and two new permissions.
