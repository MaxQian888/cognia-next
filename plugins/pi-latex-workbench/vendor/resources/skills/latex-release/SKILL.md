---
name: latex-release
description: Formal LaTeX delivery. Use when the user requests a source package, a reviewed release, or submission preparation; ordinary draft PDFs and local edit previews only need build artifacts.
compatibility: Requires approved Pi LaTeX Workbench tools and host-controlled policies.
---

# Formal delivery

1. Confirm the requested delivery profile and inspect the current snapshot/target. Map it to the supported `releaseProfileId`: `draft`, `review`, or `submission`. A request to view a draft PDF alone can end with `latex_build` output.
2. Use `latex_export prepare` for the selected tuple and read its whitelist, checks, and approval requirements. Freeze the content under review; a later edit requires new evidence for its new snapshot.
3. Clean-build the selected snapshot, resolve required checks, and render/review pages required by the profile. Use authenticated host review records; an agent cannot impersonate a human reviewer.
4. Use `latex_export package` for the same snapshot, target, and profile. Read the actual release result and blockers. When resuming a frozen release, pass its returned `releaseId` to keep approval bindings intact.
5. Return the actual package/artifact references and readiness status. Packaging includes source-whitelist validation and an independent rebuild; only their recorded outcomes justify completion.

For approval, review coverage, and packaging details, read [release recipes](references/guide.md) using resource `skill:latex-release:guide`. Follow `skill:latex-project:guide` for snapshot consistency.

A completed tool call can contain a blocked release. Report that state faithfully; uploading, public sharing, and submission require their own explicit authorization.
