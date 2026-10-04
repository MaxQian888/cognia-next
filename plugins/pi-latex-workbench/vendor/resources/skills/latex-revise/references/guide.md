# Revision recipes

## Draft or extend text

Read the section's neighbors, relevant macros, and the user's supplied evidence. Match the document's voice and language. New sections belong in the existing include structure; add a separate file and its include in one proposal only when the structure calls for it. Keep unprovided factual details as clearly identified open items outside the finished text, or explicit placeholders if the user requested a draft. Never manufacture experiments, measurements, citations, or completed proofs.

Write a new section or document body in coherent chunks: one proposal per section (or per file) is easier to review and to repair than a whole-paper rewrite, and a failing build then points at a small region. For a new project, replace the template's placeholder text rather than appending after it, and keep the template's preamble unless the request needs more packages.

Distinguish a grammatical edit from a stronger claim: "associated with" becoming "causes", changing a quantifier, deleting an assumption, or altering uncertainty changes meaning. Present that part for review rather than silently treating it as polishing. Preserve equations, labels, citation keys, command arguments, and unknown macro semantics unless explicitly in scope and host-approved.

## Tune layout

Locate the actual overflowing paragraph, float, table, or page break from current source and a current PDF; build diagnostics carry the source file and line of overfull boxes. Standard layout commands (`\small`, `\setlength{\tabcolsep}{…}`, `\makecell`, `p{…}`/`tabularx` columns, float placement) are ordinary edits, not protected content; for tables follow the fitting ladder in `skill:latex-tables:guide` and do not scale a table with `\resizebox`. Adjust one local cause at a time: appropriate figure width, column structure, paragraph break, float placement, or a targeted spacing setting already supported by the template. Preserve captions, numeric content, references, and accessibility of explanations.

Build and compare affected pages plus the next page when content can move. For a global font or class change, broaden inspection. Do not conceal overflow by clipping content, deleting results, or violating official template margins/font sizes. If a layout request would require a protected macro/template change, expose that in the proposal.

## Follow-up or undo

Record the current head and latest applied patch after each successful change. A user correction narrows or redirects the pending edit; it does not reset the project to an earlier imported directory. Re-read the changed region before computing another diff. If the user wants to undo only one portion, propose a local inverse against current content. Use `latex_patch revert` only when the original patch and its result snapshot are known; the returned inverse still needs inspection and application.

If apply/build was interrupted, inspect the current head and query the known build job before retrying. If a protected proposal is waiting, retain its patch ID and exact diff rather than generating several nearly identical approval requests.

## Completion boundary

A prose edit is complete when the requested text is applied and the affected target's build has been checked. Layout validation also needs actual page images. If the user requested suggestions only, supply the proposed wording/diff without applying or building. Report any unavailable verification accurately; neither a compile success nor visual similarity proves mathematical or scientific correctness.
