# Generic journey tree schema

`tree.json` is the hand-edited source. A repository generator turns it into a diagram; a repository validator consumes governance intent. Confirm the actual schema from those files before editing.

## Top-level model

```jsonc
{
  "root": { "label": "Cognia" },
  "colors": { "<module-key>": "#RRGGBB" },
  "legend": [
    { "role": "entry", "label": "Entry" },
    { "role": "step", "label": "Step" },
    { "role": "option", "label": "Option" },
    { "role": "result", "label": "Result" }
  ],
  "branches": [
    {
      "id": "b-module",
      "label": "Module",
      "color": "<module-key>",
      "functions": []
    }
  ]
}
```

Field names may differ in an existing repository. The current generator and validator are authoritative.

## Journey/function node

```jsonc
{
  "id": "f-stable-journey",
  "label": "User-visible outcome",
  "p": "P0",
  "spec": ["tests/e2e/area/outcome.spec.ts"],
  "chain": []
}
```

- `id`: globally unique and stable.
- `label`: user-facing capability/outcome, not an implementation class name.
- `p`: optional priority; legal values and budget come from the validator.
- `spec`: optional owning tests; supported roots come from the validator.
- `chain` or `flow`: topology; use one unless the schema explicitly permits both.

Governance fields may be ignored by the visual generator while remaining mandatory to CI.

## Linear chain

```jsonc
"chain": [
  { "l": "Entry action", "r": "entry" },
  { "l": "Intermediate state", "r": "step" },
  { "l": "Observable result", "r": "result" }
]
```

The common role convention is:

| Role | Meaning |
|---|---|
| `entry` | User or external entry point |
| `step` | Product/process step |
| `option` | Choice or branch |
| `result` | Observable outcome |

Omitted-role defaults are generator-specific. Do not assume them without reading the generator.

## Branching and merge flow

```jsonc
"flow": {
  "l": "Entry",
  "r": "entry",
  "key": "entry-anchor",
  "branches": [
    { "l": "Option A", "res": "Result A", "r": "option" },
    { "l": "Option B", "r": "option" }
  ],
  "next": {
    "l": "Merged step",
    "r": "step",
    "next": { "l": "Final result", "r": "result" }
  }
}
```

- `branches[]` fans out.
- `res` represents a branch-specific terminal or intermediate result.
- `next` continues after merge and can be recursive.
- Use explicit role values when visual meaning matters.

## Loops and retry semantics

Common encodings:

1. Add `key` to an anchor and `loopTo` to a later node.
2. Add `loop: true` to a branch with `res` to return to the flow entry.

```jsonc
"flow": {
  "l": "Queue entry",
  "r": "entry",
  "key": "queue-entry",
  "next": {
    "l": "Process one item",
    "r": "step",
    "next": {
      "l": "Next item",
      "r": "result",
      "loopTo": "queue-entry"
    }
  }
}
```

Label loops by semantic category; the same arrow can otherwise misrepresent behavior:

| Category | Meaning | Evidence |
|---|---|---|
| New operation/turn | Each iteration starts a new public operation | public start/request call |
| Same operation | Pagination, approval, or tool sequence within one operation | no new public start |
| Client poll | Timer-driven status check with no new operation | interval/timeout plus read request |
| Retry/recovery | Re-executes after failure/backoff | retry policy and state transition |
| Event-driven loop | New event/queue item drives the next iteration | subscription/queue consumer |

Verify timeouts, retry counts, backoff, queue semantics, and platform differences from current implementation. Do not preserve numbers from a diagram by assumption.

## Common edits

Add a linear journey:

```jsonc
{
  "id": "f-new-outcome",
  "label": "New outcome",
  "chain": [
    { "l": "Entry", "r": "entry" },
    { "l": "Action", "r": "step" },
    { "l": "Result", "r": "result" }
  ]
}
```

Add a branch:

```jsonc
{ "l": "New option", "res": "Option result", "r": "option" }
```

Add governance ownership:

```jsonc
"p": "P0",
"spec": ["tests/e2e/area/outcome.spec.ts"]
```

Add a module:

```jsonc
{
  "id": "b-new-module",
  "label": "New module",
  "color": "new-module",
  "functions": []
}
```

Also add its declared color when the generator requires color keys.

## Mandatory post-edit checks

1. Run the repository validator; JSON parsing alone is insufficient.
2. Run the repository generator for topology/label changes.
3. Compare modules/functions/connectors and priority/spec totals with the intended delta.
4. Confirm every spec path is source-controlled and resolves under validator rules.
5. Confirm loop targets exist, are unambiguous, and remain within supported scope.
6. Use a precise patch; do not reformat the entire source.
