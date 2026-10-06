# Documentation contract

Use this contract for every owner page.

## Evidence order

1. Runtime registration and bootstrap code
2. Current implementation and public types
3. Tests and protocol fixtures
4. Package/workspace manifests and generated-contract sources
5. ADRs and existing documentation

If sources disagree, describe the live implementation and call out the drift. Verify numerical claims directly at the pinned commit.

## Required content

Each owner needs enough detail for a new maintainer to answer:

- What problem does the module solve, and which user surfaces depend on it?
- Which technologies are used, and what repository constraint drove each important choice?
- Where does execution enter, how is the module registered, and what are its main state transitions?
- What data crosses the boundary, where is state persisted, and which process owns it?
- Which security, privacy, permission, or tenancy boundary applies?
- How do cancellation, retries, offline behavior, partial failure, and recovery work?
- Which tests prove the contract, and which observability surfaces reveal failures?
- Which extension seams are intentional, and which apparent seams are compatibility shims?
- Which design decisions are notably strong, and what concrete trade-off do they make?
- Where should a maintainer start for common changes?

## Source traceability

Use repository-relative paths and identifiers. Prefer a compact key-files table over long file dumps. A claim about a runtime path must cite its entry point and the implementation it reaches. A claimed integration must include its bootstrap, registry, command registration, route mount, or consumer.

## Bilingual parity

English and Chinese pages must preserve the same:

- heading structure;
- diagrams and tables;
- identifiers, paths, code blocks, and verified counts;
- caveats, unsupported modes, and ADR drift notes.

Translate prose naturally; do not translate identifiers or paths.

## Definition of done

- Every discovered inventory ID has one owner with existing English and Chinese files.
- Every owner page meets the required-content questions or explicitly marks a question not applicable with evidence.
- No `misc`, `other`, or `various` owner contains unrelated runtime lifecycles.
- Both sidebar trees expose the same owner set.
- The production docs build succeeds at the pinned snapshot.
