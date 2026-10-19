# Codex steering, queues, and prompt reuse: official evidence

Research date: 2026-10-19, Asia/Shanghai. Scope: current official OpenAI documentation and release notes, not an interactive verification of the installed desktop app. This report supplies the external comparison for the separate Cognia implementation audit.

## Current documented product behavior

| Capability                                 | Desktop Codex                                                         | Codex CLI                                                                     | Public app-server guide                                     |
| ------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Redirect an active run                     | Steer                                                                 | Enter during work                                                             | `turn/steer`                                                |
| Wait until the current run finishes        | Queue                                                                 | Tab during work; `codex queue`                                                | Queue CRUD contract not established by the reviewed guide   |
| Edit, reorder, send, delete queued entries | All four explicitly documented                                        | Per-entry edit/reorder UI not established by reviewed docs                    | Not established by reviewed guide                           |
| Reuse a previous prompt                    | Desktop shortcut not established by reviewed docs                     | Up/Down recall; Ctrl+R search                                                 | Client can read stored history                              |
| Edit historical user input                 | Arbitrary historical edit-and-resend not established by reviewed docs | Escape twice with an empty composer edits the previous user message and forks | Fork/revert primitives, not an inline message-edit API      |
| Retry a failed queue submission            | Release-note evidence below                                           | Reconnection recovery evidence below                                          | Idempotent retry contract not established by reviewed guide |

“Not established” means a documentation evidence gap; it does not prove the feature is absent from the implementation.

Desktop follow-up behavior is configurable in Settings > General. The queue is visible above the composer. Steer changes the active work; Queue defers a follow-up. [Prompting](https://learn.chatgpt.com/docs/prompting#steering-and-queuing).

CLI prompt recall creates an editable draft; it is distinct from editing the transcript. Editing the previous message forks the chat. The stable `codex queue --thread <ID-or-name> --message <text>` command can target local or remote sessions; image attachments are unsupported. [Developer commands](https://learn.chatgpt.com/docs/developer-commands#interactive-shortcuts), [queue command](https://learn.chatgpt.com/docs/developer-commands#codex-queue).

## Relevant update timeline

Dates below are the dates printed in the fetched changelog. Links use anchor IDs verified from the official page HTML; some mobile anchor dates differ from their displayed dates.

| Displayed date | Release                                                                            | Relevant change                                                                              |
| -------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 2026-10-15     | [CLI 0.163.0](https://learn.chatgpt.com/docs/changelog#github-release-414286110)   | Immediate follow-up steering; interrupt stops Code Mode cells and nested calls.              |
| 2026-10-08     | [App 26.1007](https://learn.chatgpt.com/docs/changelog#codex-2026-10-08-app)       | Fixed stuck Sending and secondary-window Steer.                                              |
| 2026-10-02     | [iOS 1.2026.267](https://learn.chatgpt.com/docs/changelog#codex-2026-10-02-mobile) | Queue cancellation restores recoverable text and attachments.                                |
| 2026-10-01     | [CLI 0.160.0](https://learn.chatgpt.com/docs/changelog#github-release-401312540)   | Reconnect resumes unsent input after resolving uncertain submissions, preventing duplicates. |
| 2026-10-01     | [App 26.930](https://learn.chatgpt.com/docs/changelog#codex-2026-10-01-app)        | Improved failed queue retries.                                                               |
| 2026-09-29     | [CLI 0.159.0](https://learn.chatgpt.com/docs/changelog#github-release-398926954)   | Opt-in `instant_interrupt` supports steering during responses and long Code Mode calls.      |
| 2026-09-01     | [iOS 1.2026.237](https://learn.chatgpt.com/docs/changelog#codex-2026-09-02-mobile) | Editable queued prompts synchronize with the host and send in background.                    |
| 2026-08-18     | [iOS 1.2026.223](https://learn.chatgpt.com/docs/changelog#codex-2026-08-17-mobile) | Canceling/editing steering prevents delivery.                                                |
| 2026-06-09     | [iOS 1.2026.153](https://learn.chatgpt.com/docs/changelog#codex-2026-06-09-mobile) | Latest sent prompt becomes editable.                                                         |
| 2026-02-17     | [App 26.217](https://learn.chatgpt.com/docs/changelog#codex-2026-02-17-app)        | Drag-and-drop queue reordering.                                                              |

These entries support treating queue manipulation as an established product feature, with recent work focused on responsiveness, recovery, and delivery correctness. They do not establish arbitrary historical prompt editing on every client.

## Integration semantics and limits

`turn/steer` requires a matching `expectedTurnId`, fails without an active turn, does not create another `turn/started`, and cannot change model, working directory, sandbox policy, or output schema. The guide also documents history pagination, `thread/fork` with `lastTurnId`, and `thread/revert`. Revert removes a selected turn and its successors from supported persistent history; it does not undo filesystem changes. The old `thread/rollback` method is removed. [Codex App Server](https://learn.chatgpt.com/docs/app-server).

The reviewed API overview and steering section do not specify durable queue CRUD, revision checks, reorder transactions, queue retry tokens, or a historical message replacement operation. Their absence from this guide is insufficient to conclude that no first-party or experimental protocol provides them. Validate any integration against its installed version's generated protocol/schema before selecting endpoints.

The lower-level Responses API has a separate native steering protocol. GPT-6 models support `response.steer` over WebSocket; earlier GPT-5.6 models do not. An accepted event acknowledges queued ownership, not application. The server continues automatically at an output boundary after already-running hosted tools finish; steering does not undo earlier output or started tools. This API must not be conflated with a desktop queue or Codex app-server method. [Mid-turn steering](https://developers.openai.com/api/docs/guides/steering).

## Implications for the Cognia comparison

Assess these as separate user operations and contracts:

1. **Unsent entry manipulation:** edit in place, reorder accessibly, delete, send immediately, convert between Queue and Steer.
2. **Submission recovery:** retained payload, attachments, visible failure, retry, and reconciliation when acknowledgment is uncertain.
3. **Historical reuse:** copy/restore as a new draft versus edit-and-fork versus replace-and-regenerate the conversation tail. These have different context and filesystem effects.
4. **Delivery ownership:** local draft, accepted by runtime, applied by model, completed, canceled, or failed. Queue editing must not imply that already-applied steering can be recalled.
5. **Durability and synchronization:** restart, chat switch, reconnect, background operation, multiple windows/devices, ordering conflicts, and duplicate prevention.

Official sources establish a useful product baseline, but do not settle all implementation choices. Do not label an unverified desktop history action or a public durable queue API as supported merely because related mobile or CLI behavior exists.

## Sources

- [Prompting](https://learn.chatgpt.com/docs/prompting)
- [Developer commands](https://learn.chatgpt.com/docs/developer-commands)
- [ChatGPT and Codex changelog](https://learn.chatgpt.com/docs/changelog)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Mid-turn steering](https://developers.openai.com/api/docs/guides/steering)
