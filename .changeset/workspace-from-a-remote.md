---
"cognia-next": minor
---

A task workspace can now be supplied straight from a remote repository, so an issue run can start on a machine where nobody has cloned anything by hand. This is what makes the autonomous loop usable on a headless server or in a container rather than only on a desktop with the repository already checked out. Private repositories work without the credential ever being written to disk: it is used once, for the shared mirror fetch, and the checkout that agents get never sees it.
