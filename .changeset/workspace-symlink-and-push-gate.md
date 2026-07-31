---
"cognia-next": patch
---

Close two ways a built-in plugin could be talked past its own boundary, both reachable from text an attacker controls.

Workspace Tools confined paths by string comparison alone, so it never saw a symlink. Git tracks symlinks, which means simply cloning a hostile repository into your open folder was enough to plant a link such as `docs/notes -> ~/.ssh`; `workspace_read_file` and `workspace_list_files` followed it straight out of the workspace, and a prompt-injected agent could ask for it by name. Every path component below the workspace root is now checked with `lstat`, which does not follow links, and `workspace_search` no longer descends into symlinked entries. A workspace you opened through a symlink yourself still works.

An unattended agent run in a cloned repository blocks `git push`, `git remote` and the `gh` CLI at the permission gate rather than trusting the prompt — when the task text comes from an issue or a ticket, it is written by anyone who can open one. Those rules only matched the literal spelling, so `git -C <path> push`, `git -c k=v push`, `git --git-dir=… push`, an extra space, or `env gh …` all slipped through to a prompt the unattended run could not answer. The gate now covers git's pre-subcommand options and the common exec wrappers, while still leaving `git commit -m "fix the push flow"` alone.

The same gate had a wider hole underneath it. The sidecar splits a shell command into segments before matching rules against it, and that splitter was a plain regex: it ignored quotes and never looked inside `$(…)`, backticks or subshells. So `echo $(git push)` produced one segment that matched no rule, resolved to "ask", and fell out of the hard gate into an approval prompt — which an unattended run cannot answer. The splitter is now quote- and substitution-aware, so a denied command stays denied however it is wrapped, while `git commit -m "a; b"` is no longer split into nonsense at the quoted semicolon. The sidecar ships as its own Node project and cannot import the app's parser, so this is a second implementation of the same rules rather than a shared one — `lib/claude/permissions/ruleset.sidecar-parity.test.ts` pins the two against each other so they cannot drift apart unnoticed.

Also stops `workspace_search` reading a file into memory before checking its size, so a multi-gigabyte file in the tree is skipped instead of exhausting memory.
