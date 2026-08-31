---
title: "0159 — Selection Action Platform: one host, explicit text release, validated replacement"
description: "The selection capsule becomes an extensible host-rendered action surface while native perception, plugin privacy, preview-first replacement, and short-lived undo remain authoritative."
---

# ADR 0159 — Selection Action Platform

**Status:** Accepted  
**Date:** 2026-08-30  
**Builds on:** [ADR-0093](./0093-selection-toolbar-content-hugging-window), [ADR-0095](./0095-desktop-selection-perception), [ADR-0153](./0153-the-host-obtains-the-confirmation)

## Context

ADR-0093 and ADR-0095 established a reliable native selection observer, a
content-hugging non-activating window, OCR trust provenance, secure-field and URL
gates, ten built-in actions, and stable action shortcuts. Several implemented
paths were nevertheless dormant: classification did not sharpen composer
prompts, source provenance was dropped, native health was not shown, contextual
and search preferences had no Settings UI, long selections could not use action
shortcuts, and plugin quick actions had no selection surface.

Running the authenticated plugin runtime inside the overlay would solve discovery
but violate its least-privilege design. Letting renderer or plugin code replace
foreign application text would also turn a stale preview into an unaudited input
primitive.

## Decision

### The main window owns execution

The native overlay receives serializable, host-renderable descriptors and
normalized results only. The main window owns plugin enumeration, localization,
permission consent, execution, AI clients, PII gates, timeouts, and registry
revalidation. Plugin disable/uninstall invalidates an in-flight result.

Built-ins, Cognia Rewrite, and plugin actions resolve through one layout model:
six capsule slots at most, retained ordering/hidden/pinned ids, and one
host-rendered More panel. Plugins never render arbitrary overlay UI.

### Selected text is released explicitly

`selection` is opt-in on a quick action. Metadata actions receive source facts
without text. Text actions must declare `selection:read`, a dangerous permission,
and pass the tier-aware consent broker on every invocation. The host sanitizes URL
metadata again and rejects malformed or oversized results.

### Preview is the default; replacement is native authority

Generated text and variants render with original/result comparison, attribution,
origin warning, Copy, Open in Cognia, Replace, and Cancel. Replacement is offered
only for a fresh, editable accessibility selection. Native code re-focuses the
source, rereads the selection, requires exact equality, pastes through the
existing clipboard-restoring helper, and never falls through to typing.

Direct replacement requires both an action declaration and a per-action user
allowlist entry. It remains behind `COGNIA_SELECTION_REPLACE=1` until the native
application matrix passes.

### Undo is a lease, not history

Successful replacement creates a short-lived lease bound to candidate id and the
physical-input generation. Timeout, unrelated input, focus/source loss, candidate
change, or a second use invalidates it. Undo sends only the native application's
undo chord.

### Modes, exclusions, and shortcuts are native concerns

`off`, `automatic`, and `manual` replace the boolean preference. Hostname rules
are reduced to exact or explicit-wildcard hostnames and checked before candidate
text publication. Selection chords remain persisted/reserved while off but their
OS registrations exist only while the selection scope is active. Action chords
capture the live selection on demand, including selections above the automatic
4,000-character threshold.

## Consequences

- The overlay stays lightweight and usable while the main window is hidden, but
  plugin descriptors/results require the main renderer to be alive.
- Permission probes are non-prompting; opening a system pane is an explicit user
  action. Screen Recording is never requested implicitly.
- OCR, clipboard, stale, changed, read-only, and unavailable sources degrade to
  Copy/Open rather than a weaker replacement path.
- Plain text is the only replacement claim. Rich-text preservation is explicitly
  unsupported.
- Contract 1.2.0 and SDK 0.3.0 are additive; older plugins retain their original
  palette/composer/tray behavior.
