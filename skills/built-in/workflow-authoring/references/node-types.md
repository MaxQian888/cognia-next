# Workflow node taxonomy & validation

Reference for building valid graphs with the `wf_*` tools. Read the live graph
with `wf_read_graph` first; this just explains the kinds and the common failures.
Draft changes with `wf_propose_batch`. The host owns review and apply after user
approval; do not call legacy direct-mutation tools to skip that proposal gate.

## Node kinds

| Kind | Role | Connection rule |
| --- | --- | --- |
| Trigger | Starts a run (manual, schedule, event, inbound) | Has outputs only; exactly one start path |
| Action | Does work (LLM turn, tool call, HTTP, transform) | Inputs wired from upstream; outputs feed downstream |
| Branch | Splits flow on a condition | One input; multiple labeled outputs |
| Loop | Iterates a sub-body over items | Body nodes parent to the loop; bounded |
| Group | Visual container for related nodes | Organizational; children still run as wired |

## Wiring rules
- A trigger begins the flow; every runnable path traces back to one.
- An action with an unconnected required input is a dead node — it breaks the run. Wire inputs as you place the node.
- Outputs connect only to compatible inputs. A branch's labeled outputs must each go somewhere (or be intentionally terminal).
- Don't connect a node's output back into its own upstream unless it's inside a loop body — that's an accidental cycle.

## Common validation errors → fix
| Error | Fix |
| --- | --- |
| "Node has no incoming connection" | Wire it from the correct upstream output, or delete if orphaned |
| "Required field empty" | Fill the node's config (model, prompt, URL, condition) |
| "Unreachable node" | Connect it into a path that traces to the trigger |
| "Cycle detected" | Remove the back-edge, or move the nodes into a loop body |
| "Branch output unconnected" | Route every labeled output, or mark it terminal |

## The repair loop
1. Read validation errors + run status — they name the offending node/edge.
2. Fix the named cause, not a symptom.
3. Re-validate. Repeat until clean. Don't claim "fixed" until validation passes.
