# Parallel audit protocol

Delegate only after the inventory has stable owner IDs and non-overlapping path ownership.

## Assignment packet

Give each agent:

- the pinned commit and worktree path;
- owner IDs and exact English/Chinese files it owns;
- mapped source paths, ADR candidates, and known entry points;
- the documentation contract;
- explicit instruction not to edit another agent's files or revert concurrent changes;
- required evidence and validation commands.

Split by cohesive runtime cluster, not by language. The same agent owns English and Chinese for its pages so translation cannot drift from research.

## Agent return contract

Require:

- files changed;
- source ledger and verified counts;
- ADR/implementation drift found;
- commands run and results;
- unresolved cross-owner questions.

The coordinator resolves shared terminology, sidebar order, cross-links, inventory ownership, and final builds after all agents finish.
