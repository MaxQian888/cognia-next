---
name: cognia-project-documenter
description: Inventory, audit, and write implementation-accurate bilingual documentation for every architectural module in the Cognia repository. Use for whole-project architecture surveys, module-by-module introductions, documentation coverage audits, or broad subsystem refreshes; use subsystem-docs for a single already-known subsystem.
---

# Cognia Project Documenter

Produce a complete, source-traceable map of a Cognia snapshot and detailed Fumadocs pages for every architectural owner. Renovate good existing pages instead of creating competing descriptions.

## Completeness contract

1. Pin one immutable commit before research. Record it in `docs/module-coverage.json`; never mix observations from different commits.
2. Run `scripts/inventory-modules.mjs --json` from this skill to discover deployables, application routes, workspace packages, Rust crates, services, plugins, built-in skills, documented product subsystems, and first-level frontend domains.
3. Treat each discovered unit as evidence that must have exactly one owning documentation page. A page may own several tightly coupled units, but every unit must appear in `docs/module-coverage.json` with existing English and Chinese owner paths.
4. Do not use a catch-all page to hide unrelated units. Split a page when its units do not share one runtime, data model, or lifecycle.
5. Describe the implementation at the pinned commit. ADRs explain intent; source, tests, manifests, registration/bootstrap points, and user routes establish current behavior.

Read [references/documentation-contract.md](references/documentation-contract.md) before writing pages. Read [references/parallel-audit.md](references/parallel-audit.md) before delegating module clusters.

## Workflow

### 1. Freeze and inventory

- Work in an isolated worktree when the checkout is dirty or shared.
- Capture the commit, workspace manifests, runtime entry points, route surfaces, ADRs, existing docs, and tests.
- Generate the inventory and establish ownership in `docs/module-coverage.json` before parallel writing. Resolve overlaps and unmapped units first.

### 2. Research by owner

For each documentation owner, inspect all mapped units together:

- purpose and user-facing capabilities;
- technology choices and why they fit the constraints;
- runtime topology, bootstrap/registration, control flow, and data flow;
- persistent state, schemas, protocols, and trust boundaries;
- failure handling, cancellation, recovery, and platform degradation;
- tests, observability, extension seams, and notable design decisions;
- implementation drift from ADRs or older docs.

Keep a source ledger with concrete paths and verified counts. Never infer wiring from filenames alone.

### 3. Write or renovate

- Follow the repository's `subsystem-docs` conventions under `docs/content/docs/{en,zh}/`.
- Prefer an overview page plus focused child pages when one owner spans several planes.
- English and Chinese pages must be structurally equivalent full documents, not summary translations.
- Include a whole-system Mermaid diagram, a key-files table, and a practical "where to change" section when they improve comprehension.
- Add pages to both sidebar trees and preserve stable slugs.

### 4. Reconcile and verify

- Run `scripts/inventory-modules.mjs --check docs/module-coverage.json`.
- Review cross-owner terms, links, duplicated claims, counts, and boundary descriptions.
- Run the production docs build. Inspect the tail of every generated MDX file for agent-output leakage.
- Report the pinned commit, owner/page counts, mapped-unit counts by kind, intentional exclusions, and verification results.

## Boundaries

- Do not document generated outputs, fixtures, or vendored dependencies as architectural owners; map the generator or integration instead.
- Example plugins and skills are individually inventoried but may share a detailed catalog page when their host contract and lifecycle are the real architecture.
- Do not rewrite source code while documenting unless the user separately authorizes implementation changes.
