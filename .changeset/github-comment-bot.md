---
"cognia-next": minor
---

New built-in GitHub Comment Bot: allowlisted collaborators with write access can `@`-mention it in issue and pull request comments to ask questions or get a read-only comment review, check task status, cancel, or get help. It works through webhooks or polling, re-checks the author and the comment before answering and before publishing, never answers its own comments, and publishes automatically under an explicit host grant or after approval. A Check readiness run reports what is missing (ingress, account permission, a private checkout, the publication grant, the model route) with stable codes, and a second installation answering the same trigger in the same repository is refused.
