# Companion-document discovery and ownership

Do not embed organization-specific document tokens in the skill. Resolve current document identities from user input, repository configuration, or environment variables, then read titles and outlines before writing.

## Recommended registry

Maintain or discover these logical roles:

| Role | Purpose | Update trigger |
|---|---|---|
| Product/journey overview | Human-readable product panorama and embedded journey board | Topology/label changes or a board replacement |
| E2E governance | Source schema, validator, priority budget, CI enforcement, debt policy | Validator, priority/spec, CI mode, or reconciliation changes |
| Coverage/gap ledger | Current journey-to-test status and blocked harness | Coverage evidence changes |
| Telemetry/measurement | Signals attached to journey outcomes and failures | Measurement design or verified signal changes |

One document may own multiple roles. Do not assume a fixed count.

## Identity discovery

Prefer, in order:

1. Explicit document URL/token in the user request.
2. Source-controlled registry near the mindmap README.
3. Environment/config supplied by the repository, such as:
   - `COGNIA_MINDMAP_DOC_TOKEN`
   - `COGNIA_MINDMAP_SECTION_ID`
   - repository-specific companion document registry.
4. Read-only Lark search by exact title, followed by title/outline verification.

Never use a stale token merely because it appeared in an old report. Never infer the authoritative source branch from a remote document.

## Board update is not body update

Replacing an embedded whiteboard changes the board graph only. Tables, summaries, quick references, and gap ledgers are separate Docx blocks and require separate, explicitly scoped edits.

## Safe block workflow

```bash
rtk lark-cli docs +fetch --api-version v2 --doc "<token>" \
  --scope outline --max-depth 3

rtk lark-cli docs +fetch --api-version v2 --doc "<token>" \
  --scope section --start-block-id "<heading-id>" --detail with-ids

rtk lark-cli docs +update --api-version v2 --doc "<token>" \
  --command block_insert_after --block-id "<anchor-id>" --content - < update.xml
```

Use `scope keyword` with an exact, stable term when no heading ID is known. Fetch the resulting section after every write.

## Reconciliation rules

- Current code, validator, config, and E2E results outrank prose.
- Dated design/coverage documents are historical evidence; append a dated reconciliation or regenerate.
- Do not change measurement claims without verified owning code and platform evidence.
- Do not let a board sync silently rewrite E2E governance or telemetry commitments.
