# Laya Guard — inbound IM moderation for Cognia

A Python plugin that runs [laya](https://github.com/NandhaKishorM/laya), a
non-autoregressive "System 1" decision engine, as a local moderation gate for
inbound connector messages (Lark / Slack / Discord / Telegram). One ~60 ms
encoder forward pass per message — no LLM call, no network round-trip after
the checkpoint is cached.

## What it does

- **`onConnectorInbound` hook** — scores inbound messages on `spam` /
  `threat` / `harassment` / `toxic` before they reach an agent run. Ships in
  `inboundMode: "observe"`: nothing is dropped; flagged messages increment
  `wouldBlock` in `laya_status` so you can watch the score distribution on
  real traffic. Flip to `"enforce"` to actually drop. The hook fails open
  (allows) while the model is loading or on any error.
- **`laya_moderate_check` tool** — the same verdict on arbitrary text, for
  inspection and tuning.
- **`laya_status` tool** — checkpoint readiness, configured backend, counters.
- **`laya_decide` tool** — raw passthrough: ask arbitrary typed questions
  (`choice` / `score` / `noul`) in one forward pass.

## Checkpoint routing

Default `checkpoint: "auto"` uses laya's `Router` — it detects script/language
per request (<0.5 ms) and dispatches to the English or multilingual checkpoint
as appropriate. This matters: the English checkpoint misfires badly on text it
cannot read (a benign Chinese prompt scored 1.0 on a jailbreak probe in
validation). Pin `multilingual` or `english` only if your traffic is known.

## Measured behavior (why this scope)

Validated locally on the real checkpoints (Apple Silicon, MPS):

- **Inbound moderation works**: spam scored 1.0, clearly toxic ~0.77, clean
  en/zh messages ≤0.06 across every field — the default 0.75 threshold sits
  in a wide gap.
- **Prompt-injection guarding does not** (removed): the base checkpoint scored
  ~1.0 on ordinary system prompts, git diffs, and `.env` files — it cannot
  separate "text containing instructions" from "malicious instructions"
  zero-shot, and rewording the questions did not fix it. That surface would
  need a purpose-built injection classifier or a fine-tuned checkpoint.
- **Long input is head-only**: `predict` keeps roughly the first ~700 tokens
  (multilingual). Messages past `maxChars` are truncated and the verdict
  reports `truncated: true`. Chunked scanning was evaluated and rejected —
  sliding-window max-pooling false-positives on repetitive benign text.

## Config

| Key                 | Default   | Notes                                                                   |
| ------------------- | --------- | ----------------------------------------------------------------------- |
| `checkpoint`        | `auto`    | `auto` / `english` / `multilingual` / `typed-decisions`                 |
| `inboundModeration` | `true`    | Set `false` to keep tools but stop scoring messages entirely            |
| `inboundMode`       | `observe` | `observe` counts would-be-blocks only; `enforce` drops flagged messages |
| `inboundThreshold`  | `0.75`    | Lower toward 0.5 to catch the softer threat band                        |
| `warmup`            | `true`    | Background-load the checkpoint at plugin startup                        |
| `maxChars`          | `2800`    | Head-window size (~700 tokens) before `truncated`                       |

## Requirements & permissions

- Desktop (Tauri) only — Python plugins run in the desktop subprocess host.
- `python:execute` + `network:fetch` (one-time ~1.3 GB checkpoint download
  from HuggingFace; cached afterwards). No chat-interception permission:
  this plugin never sees outgoing prompts.
- `pythonDependencies: ["laya==0.3.5"]`, isolated venv.

## Environment preparation

The Cognia Python runtime auto-provisions the venv and installs
`pythonDependencies` (it can bootstrap `uv` itself). What it cannot provide:

| Requirement                 | Details                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Disk space**              | ~2 GB free below the HF cache for weights (plus ~3 GB venv: torch + transformers). A cold load on a nearly-full disk fails fast with `errorKind: "low_disk"` — free space or move the cache. |
| **Python ≥3.10**            | laya's floor. The runtime picks the plugin venv interpreter; override via host settings if the probed interpreter is too old.                                                                |
| **Network, first run only** | Egress to `huggingface.co`, `*.hf.co` (xet CDN), `*.huggingface.co` (LFS CDN), or `hf-mirror.com`. After weights are cached, runs fully offline.                                             |
| **RAM**                     | ~1.5 GB resident per loaded checkpoint (auto router holds ≤2).                                                                                                                               |

Useful environment variables (inherited by the host process):

- `HF_ENDPOINT=https://hf-mirror.com` — mirror for networks where
  huggingface.co is unreachable; `hf-mirror.com` is already in
  `allowedDomains`.
- `HF_HOME` / `HF_HUB_CACHE` — relocate the model cache (e.g. a data volume
  with more space).
- `HF_HUB_OFFLINE=1` — run strictly from cache after the first download.

Failure modes are reported, never thrown: `laya_status.errorKind` is one of
`deps_missing` (venv install failed — reinstall the plugin), `low_disk`,
`download_failed` (network/HF unreachable), `load_failed` (anything else).
While `ready: false`, inbound messages pass through unmoderated.

## Development

```bash
# unit tests (stubbed agent, no model download)
uv run --no-project --with pytest pytest tests/

# plugin gates
cognia plugin lint && cognia plugin build
```
