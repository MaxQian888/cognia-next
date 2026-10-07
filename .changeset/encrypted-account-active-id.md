---
"cognia-next": patch
---

Accounts with encrypted local data (every desktop account) now resolve their real id everywhere: sync, collaboration and cloud sign-in looked for the session under a wrong id and treated a signed-in profile as signed out. Workflow deployments, publications and generated videos recorded under the old id on desktop are not carried over.
