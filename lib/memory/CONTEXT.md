# CONTEXT — Personal Memory

Domain language for durable personal recall. Keep these terms distinct even when
the product presents them through one management experience.

## Glossary

### Learned memory

A durable fact, event, or working preference inferred from a conversation or
deliberately saved by the user. Learned memory is recall context, not enforced
policy.

### Human instruction

Guidance written by a user, team, or administrator. Human instructions have an
explicit author and precedence; they are not learned memory.

### Memory control plane

The shared governance experience for deciding whether learned memory may be
created, recalled, revised, promoted, retained, or deleted. It may present
related context sources without merging their authority or lifecycle.

### Evidence

An immutable reference to the source that supports a learned memory. Evidence
lets a person inspect why the memory exists without treating a generated summary
as its own proof.

### Legacy memory

A learned memory created before evidence tracking was available. Legacy memory
remains usable but must not be presented as if its source or confidence were
known.

### Promotion

An explicit decision to turn reviewed evidence, a task checkpoint, or an agent
finding into learned memory. Promotion preserves the original authority and
source instead of silently upgrading it.

### Task checkpoint

A continuity record for unfinished work. A task checkpoint belongs to a task or
conversation lifecycle and does not become learned memory without promotion.

### Procedure

A reusable way of working, owned by a Skill or Workflow. Procedures load when
needed; they are not factual learned memory.

### Team blackboard

Short-lived coordination state shared by agents working on the same run. Team
blackboard entries are not personal learned memory.

### External context

Content supplied by tools, MCP, web search, files, connectors, or screen capture.
External context is evidence with an independent trust level and never becomes
learned memory merely because it appeared in a conversation.

### Contaminated turn

A conversation turn whose answer depended on external context. A contaminated
turn may use learned memory, but it does not create learned memory automatically;
reviewed evidence can still be promoted explicitly.
