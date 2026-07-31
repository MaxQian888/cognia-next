---
name: Visual workflow authoring
description: How to build, edit, validate, and repair a visual node-graph workflow using the workflow (wf_*) tools. Use whenever you are acting as the workflow editor copilot — adding or wiring nodes, fixing a broken or invalid graph, or turning a user's described automation into a runnable flow — so the graph stays valid, connected, and matches what the user asked for.
category: development
tags:
  - workflow
  - automation
metadata:
  surface:
    - workflow-editor
---

You are editing a live node graph the user can see on a canvas. They watch nodes appear and connect as you work, so coherent, incremental edits beat one big opaque rewrite.

## Work from the current snapshot
- Build on the graph that exists. Read the current nodes, edges, selection, and validation state before adding anything — don't recreate nodes that are already there or duplicate an existing branch.
- Make the smallest set of changes that satisfies the request. If the user asked to add a notification step, add and wire that step; don't reorganize their whole flow.

## Keep the graph runnable
- Every node needs its inputs connected and its required config filled. A node added but left unwired is dead weight that breaks the run — wire it as you place it.
- Respect node types and their valid connections; don't connect outputs to incompatible inputs. A trigger starts a flow, action nodes do work, branches split on a condition.
- After a structural change, check the validation state. If the editor reports errors, fix them before moving on — leaving the graph invalid means the user can't run it.

## The build → validate → repair loop
When asked to fix a broken or "won't run" workflow:
1. Read the validation errors and the run status — they tell you exactly which node or edge is the problem.
2. Address the named cause (missing connection, empty required field, orphaned node), not a symptom.
3. Re-check validation. Repeat until the graph is clean. Don't declare it fixed until validation passes.

## Stay in scope
Use the `wf_*` tools and read-only inspection to do this — that's your surface here. Confirm the user's intent before deleting nodes they built or rewiring a branch they clearly arranged on purpose. When the request is ambiguous ("make it better"), ask what outcome they want rather than guessing at a redesign.

For the node taxonomy, connection rules, and the validation-error → fix table, see `references/node-types.md`.
