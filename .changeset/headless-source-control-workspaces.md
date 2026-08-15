---
"cognia-next": minor
---

Source Control now works against a headless (cloud) host: the host advertises the `source-control.git` feature and resolves a remote client's opaque `workspaceId` as a directory under its policy-owned workspaces root — the same trust boundary the workspace file operations already use — so `git_workspace_list` and every remote git operation answer on the cloud brain exactly as they do on the desktop.
