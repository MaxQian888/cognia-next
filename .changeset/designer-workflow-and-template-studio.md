---
"cognia-next": minor
---

Workflow designer and Template Studio overhaul.

The workflow editor's frame now uses the shell's own resizable panels, edge-panel motion clock, chrome-height token, Context Workbench phone drawer and Surface tiers, gains a tablet layout, and drops an unreachable mobile branch. The node palette splits its 124-entry "Actions" list into fifteen sections, the canvas and the palette stop rendering two different icons for the same node, and agent nodes carry their model, tool, skill and member counts on the card.

Agent-shaped inspector fields stop asking for hand-typed ids: model, tools, skills, subagents, external agents, team members and plan steps all open the registries the app already reads. Eight synthesizer-emitted node kinds get real labels and icons plus a diagnostic that explains, at edit time, which runtime context they need, and `/plan to-workflow` output is finally runnable. Canvas nodes show each step's tokens and cost and open its run. Natural-language authoring gains entry points from the empty canvas, the command palette and a canvas selection, plus `wf_list_teams` and a designer subagent that reads the live catalog.

On a phone the canvas registers its loop and group renderers (they previously fell through to React Flow's default), gains a long-press action sheet with copy, paste, duplicate, delete and run-from-here, gains marquee multi-select on the desktop selection toolbar, and no longer forces the wide-axis orientation.

Template Studio stops answering its own confirmation questions on publish and instantiate, replaces thirteen kinds of text box with typed binding controls, wires the instance update/detach/fork/deprecate lifecycle that ADR-0100 advertised but never exposed, reports errors that previously vanished, and fixes the domain filter, node-group instantiation crash, two broken editor links, package download and card keyboard access.
