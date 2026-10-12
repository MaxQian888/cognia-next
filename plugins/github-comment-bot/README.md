# GitHub Comment Bot

An installable Cognia Bot that answers `@`-mention commands in a repository's issue and pull request comments. It reuses the Bot control plane, GitHub Delivery, shared decisions, isolated workspaces and the external agent runtime. It has no HTTP client of its own, no queue, no credentials and no approval UI.

## Commands

Start a line with the trigger mention; one command per comment.

| Command                         | What happens                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@bot ask <question>`           | A read-only agent answers from the repository and the thread.                                                        |
| `@bot review [focus]`           | A read-only comment review of the pull request, pinned to its exact head commit. Never approves or requests changes. |
| `@bot status [task]`            | The thread's tasks and their state. No model call.                                                                   |
| `@bot cancel [task]`            | Cancels the latest (or the named) task in the thread, including a pending publication decision.                      |
| `@bot help` or the bare mention | Usage.                                                                                                               |
| `fix`, `retry`                  | Not enabled yet; answered with a fixed reply.                                                                        |

Free text after the mention is an `ask`. Mentions inside code, quotes, HTML comments or the middle of a sentence never count. Reserved verbs (`merge`, `approve`, `release`, `exec`, `deploy`) are refused.

## Install and configure

Build with `pnpm --dir plugins/github-comment-bot build`, or create an archive with `pnpm --dir plugins/github-comment-bot pack:plugin`. Install and enable GitHub Delivery first, then this plugin. In the Bot installation screen:

- bind the `github` credential slot (a GitHub App account is recommended);
- set `repository` (`owner/repo`) and `allowedAuthorIds`, the numeric GitHub user ids that may command the Bot (required, no default);
- `trigger` defaults to the App's own `@<slug>` on an App account; a personal-token account must set it, because its login is a person's;
- choose the installation's model route: a Cognia model (through the gateway, with its per-request PII check and a hard cost ceiling) or the agent's own login;
- arm the `github` trigger when webhooks reach this host, and the `poll` trigger either way (polling is the fallback and the safety net).

## Safety

- **Who:** an author must be on the allowlist **and** have write access according to GitHub, checked by user id when the command arrives, when the answer starts, and again before anything is published. A refusal is logged locally and never announced.
- **What runs:** the agent works in an isolated, disposable checkout at the exact revision. After it finishes the checkout is diffed; any change blocks publication (`readonly_violation`).
- **What is written:** answers, replies and tracking comments go through GitHub Delivery's brokered actions under an approval for the exact content — automatic publication is the host's policy mode and needs an explicit autopilot grant; approval mode asks a person every time. Every comment carries an invisible marker, so the Bot never answers itself, and a write retried after a lost response finds its earlier copy instead of posting twice.
- **What is sent:** context is bounded (2 MiB read, 256 KiB / 24k tokens selected), stripped of control sequences, and redacted by the host before any agent sees it.
- **Edits and deletions:** an edit replaces the command's earlier version; a deletion cancels its work. Commands older than `commandMaxAgeHours` (default 24) are not run.
