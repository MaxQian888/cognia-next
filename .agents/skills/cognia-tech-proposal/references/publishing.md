# Publish a proposal to Lark safely

Publishing is optional and external. A local-document request does not authorize it.

## Preconditions

1. Canonical Markdown is complete and saved under `docs/plans/` or the approved ADR location.
2. Proposal review checklist passes.
3. Destination folder/wiki node/document is explicit.
4. User has authorized the external write.
5. Lark authentication and permissions are valid.

Invoke `lark-doc` for document operations, `lark-wiki` for wiki placement, `lark-drive` for folders, `lark-whiteboard` for an existing board, and `lark-whiteboard-mindmap` only for a screenshot-rich hierarchical mindmap.

## Create or update

- New document: create at the confirmed destination, then record returned token/link.
- Existing document: fetch outline and target section with block IDs; update precise blocks.
- Do not use full overwrite merely for convenience. It can remove comments, media, and concurrent edits.
- Keep local Markdown canonical; remote rendering is a publication artifact.

## Formatting

- Preserve headings, tables, callouts, code blocks, checkboxes, and links.
- Keep Mermaid/ASCII source in Markdown.
- Important architecture/state/flow diagrams may be rendered as Lark whiteboards and embedded.
- Quote Mermaid labels with punctuation and verify renderer compatibility.
- Do not embed local absolute paths as remote links.

## Verification

After write:

1. Fetch title, outline, and edited sections.
2. Confirm no placeholders remain.
3. Confirm tables/code/checkboxes/links rendered.
4. Query/preview every created whiteboard.
5. Confirm comments/unrelated blocks remain for in-place updates.
6. Return local path, remote link, and any rendering differences.

## Review operations

The published document should end with:

- numbered decisions with recommendations;
- reviewer/role table;
- review conclusion;
- TODOs with one owner and ISO DDL;
- link back to canonical repository Markdown.

Do not message reviewers, schedule meetings, or overwrite shared documents unless separately requested.
