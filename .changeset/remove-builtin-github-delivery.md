---
"cognia-next": minor
---

The built-in GitHub Delivery stack is removed. The Settings section, the `/github-delivery` board, the `/me/github-delivery` page, the thirteen `action.github.*` workflow nodes, the `trigger.github.webhook` trigger, and the bundled plugin that provided all of them are gone. A workflow that used those nodes will report the node kind as removed rather than running it, and the repository configuration, work orders, delivery events and policy audit rows the plugin kept in its own tables are no longer read by anything in the app.

The reason is that it was never really one feature. It was a GitHub client, a policy engine, a webhook receiver, an approval bridge, an AI worktree driver and a workflow node pack, all shipped as a built-in and all maintained on the assumption that "delivery" is something the app owns. It is not: it is one integration among many, and the Marketplace Integration runtime is where an integration belongs. Keeping it built in meant every plugin-runtime change had to keep one privileged tenant working, and that privileged tenant is what stopped the runtime from being general.

If you were using it, a one-major-version compatibility installer ships at `packages/plugin-sdk/contract/compat/github-delivery-2.0.0.zip`; verify it with `cognia plugin verify` and install it to keep the same delivery flows running on the Integration runtime. Its README carries the publisher fingerprint and the bundle checksum.

The generic pieces stay, because they were never delivery-specific: pull-request observation still feeds Agent Team's PR feedback loop, and the git workspace abstraction is still the backend registry a plugin implements to run work in a cloned repository, locally or in an E2B sandbox. Installing a plugin from a GitHub repository is a separate feature and is untouched.
