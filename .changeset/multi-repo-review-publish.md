---
"cognia-next": patch
---

Fix cross-repository review publishing posting comments to the wrong repository.

Reviewing more than one repository at once collected comments correctly across all of them and then published every comment to whichever repository happened to be first in the list. A note written on a file in the second repository was filed against the first repository's pull request, at whatever file sat at that path there — or against nothing at all, with no error. Publishing is now one pull request per repository, and a comment can only reach the repository it was anchored to; a review that names more than one repository is refused outright rather than resolved by guessing.

The repositories in a review are now treated as separate throughout. Each one gets its own branch, its own pull request and its own base, target and commit refs — previously a single set of refs was applied to every selected repository, which asked each one a question about someone else's history, and the Push and Create actions only ever ran against the primary repository no matter how many were selected.

Publishing reports each repository's outcome separately. One repository failing no longer hides or undoes another's success, and retrying re-sends only the repositories that failed. A repository whose request never came back is called out on its own, because replaying that one could post the same review twice.

Loading a review is also much lighter: the file list costs one request per repository instead of a full diff for every changed file up front, and a file's diff is fetched when you open it. Files you had already commented on are still loaded immediately, so nothing you wrote earlier goes missing from the draft.
