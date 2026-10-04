# Release recipes

## Draft artifact versus release package

A normal build produces a PDF artifact for writing and feedback. This does not require formal release checks, source packaging, independent rebuild, or a submission claim. Invoke this skill when the user actually requests that deliverable; do not turn every edit into a release.

`latex_export prepare` accepts `snapshotId`, `targetId`, and `releaseProfileId` (`draft`, `review`, `submission`) and returns the plan. Use its actual requirements rather than imposing submission gates on every draft. Record the frozen source tuple, build/PDF artifact, and applicable toolchain/profile evidence.

## Review the frozen content

Build cleanly and inspect citation/reference diagnostics, expected assets, fonts, protected-content fidelity, and applicable official rules. Run `latex_check run` with `rulesetId: "release"` against the compiled PDF when release checking is needed; use a real baseline artifact if one is available. Read report outcomes rather than treating tool completion as check success.

For full-page review, render every page in manageable batches. Inspect the attached images; retry pages listed in `imagesTruncated`. Text extraction or generated page paths alone cannot stand in for visual review. Required human review and approvals must be recorded by the authenticated host, not by a model claiming a reviewer identity. Unreviewed science, ethics, rights, or unverified venue requirements remain explicit gates where the profile requires them.

## Package and resume

`latex_export package` performs freezing, checks, whitelist validation, host approval gating, source staging, independent rebuild, and finalization. It has no model-facing `approve` or `finalize` action. If blocked, preserve the returned release identity, digest, and blocking codes. After the host supplies the required approval/review, retry with the same `releaseId` and frozen tuple; creating a new release would invalidate a grant bound to the old one.

Review the source whitelist for all required includes, bibliography material, styles, fonts where licensed, and legitimate original figures. Exclude secrets, internal audit material, and unauthorized answer keys according to the plan. Verify package output and independent rebuild evidence from the actual result; merely creating `source.zip` is insufficient.

If source changes during release preparation, treat the changed snapshot as a new candidate with new evidence and approval bindings. Preserve the old frozen release for traceability. Return draft/review/submission readiness only to the extent recorded by the host's release result, including every unresolved blocker.
