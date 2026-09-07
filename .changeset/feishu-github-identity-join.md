---
"cognia-next": minor
---

Signing in through GitHub or Feishu now joins the login to the person the IM adapters already know. The collaboration server reports the Logto social identities (GitHub id, Feishu union id and tenant) with the account's memberships, and adoption links them onto the canonical user, so a Feishu bot's principal and the same person's cloud sign-in resolve to one User. A subject already held by another user is reported as a conflict, never merged silently.
