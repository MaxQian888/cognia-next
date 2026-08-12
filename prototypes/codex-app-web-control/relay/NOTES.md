# Relay prototype verdict

## Final result — 2026-08-12

The viable prototype is **normal App ownership plus loopback CDP command ingress plus App-owned
rollout mirroring**.

The live process/runtime evidence was:

```text
ChatGPT.app/Contents/MacOS/ChatGPT
  └─ ChatGPT.app/Contents/Resources/codex
       -c features.code_mode_host=true app-server --analytics-default-enabled
```

There was no relay shim, shared daemon, second App Server, or App Server listener. CDP listened only
on `127.0.0.1:9229`.

### Browser proof

A task created through the Cognia bridge was owned by `Codex Desktop`, loaded the installed Browser
skill, connected to `Codex In-app Browser`, claimed the supplied local tab, read:

```text
Browser Use verification
3001F71F56702D41
```

and completed with:

```text
BROWSER_RELAY_OK 3001F71F56702D41
```

The bridge mirrored the session, turn, Browser tool calls/outputs, assistant answer, and completion
from the App-owned rollout file.

### Switched-conversation proof

The first follow-up implementation was unsafe: it used the currently visible composer and matched
the phrase `run` inside `Select where to run the chat`. It was corrected in two ways:

1. Every follow-up is bound to the canonical rollout `threadId` and opens
   `codex://threads/<threadId>`.
2. Submission is allowed only after the App DOM renders the same canonical conversation ID, using
   the element marked `data-codex-composer="true"` and an exact submit label (`Send`, `Queue`,
   `Submit`, or `Run`).

The App was deliberately switched from target thread
`019ff22a-2bb7-7730-9ed3-6fdc214dba44` to another task
`019ff086-698f-74d0-a016-04ecf246b9d2`. The relay then reopened and verified the target, submitted
the follow-up, and mirrored `THREAD_BOUND_FOLLOWUP_OK` from the target rollout.

## Rejected approaches

### Transparent CLI shim

The App, shim, and bundled App Server shared protocol events successfully, including tasks, skills,
MCP, approvals, and responses. However, the App-private IAB backend disappeared whenever the shim
was inserted, with or without CDP. Returning to normal startup restored IAB immediately.

### Shared local daemon / UDS runtime

One Unix App Server accepted multiple logical WebSocket clients and shared task subscriptions. The
desktop App attached to that daemon without spawning a second App Server. Nevertheless, IAB was
unavailable to both Web-created and ordinary App conversations. Returning to a normal App-owned
child restored IAB.

## Boundary

This prototype proves a practical control-and-display route, not a supported embedding API. It
depends on private desktop deep links, renderer DOM markers, Chromium CDP, and rollout JSONL format.
A production Cognia integration should version-gate the desktop build, fail closed when selectors or
rollout formats change, keep all listeners loopback-only, and require explicit local pairing.
