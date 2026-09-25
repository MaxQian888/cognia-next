# Laya (local System-1) — inbound IM moderation and typed decisions for Cognia

A Python plugin that runs [laya](https://github.com/NandhaKishorM/laya), a
non-autoregressive "System 1" decision engine, as a local moderation gate for
inbound connector messages (Lark / Slack / Discord / Telegram). One ~60 ms
encoder forward pass per message — no LLM call, no network round-trip after
the checkpoint is cached.

## Shipped, but off until you enable it

The desktop installer seeds this plugin onto disk, but it stays **disabled
until you enable it** (Plugins → Laya (local System-1) → Enable). Nothing runs,
provisions or downloads before that.

Enabling it does real work, once:

- the host provisions an isolated Python venv and installs `laya==0.3.5`,
  which pulls torch + transformers (~3 GB on disk);
- with `warmup` on (the default) the plugin then starts loading the laya
  checkpoint in the background, which on first run **downloads the weights
  from HuggingFace (~1.3 GB per checkpoint; `checkpoint: "auto"` preloads the
  English and the multilingual one, so budget ~2 GB of disk)**. They are
  cached afterwards and later starts run offline.

Until the checkpoint is ready every hook passes messages through unmoderated
and `laya_status` reports `loading`. Disabling the plugin stops it; the
downloaded weights stay in the HuggingFace cache (`HF_HOME` / `HF_HUB_CACHE`)
until you clear it.

## What it does

- **`onConnectorInbound` hook** — scores inbound messages on `spam` /
  `threat` / `harassment` / `toxic` before they reach an agent run. Ships in
  `inboundMode: "observe"`: nothing is dropped; a flagged message keeps
  flowing with its scores attached as labels (`{ action: "annotate" }`,
  ADR-0194 — shown as chips on the message, with a hover note written in the
  app's language) and increments `wouldBlock` in
  `laya_status`, so you can watch the score distribution on real traffic.
  Flip to `"enforce"` to actually drop. The hook fails open (allows) while the
  model is loading or on any error.
- **`laya_moderate_check` tool** — the same verdict on arbitrary text, for
  inspection and tuning.
- **`laya_status` tool** — checkpoint readiness, configured backend, counters
  (`blocks` = messages actually dropped, `wouldBlock` = observe-mode matches).
  `retry: true` retries a failed load immediately instead of waiting out the
  5-minute back-off.
- **`laya_decide` tool** — ask arbitrary typed questions (`choice` / `score` /
  `noul`) in one forward pass. Returns `{ok: true, answers, latencyMs,
routing?, truncation?, stateTrimmed?}` or `{ok: false, error: {kind,
message}}`.

## Decision provider (`laya-local`)

The plugin contributes `manifest.decisionProviders[laya-local]` (ADR-0194), so
the host's `ctx.decisions` — and features built on it, such as the IM reply
copilot — can answer typed questions on this machine. Select **Laya (local)**
in Settings → Conversation → Decision provider. The host redacts and PII-gates
every request before it reaches the plugin; `decide` honors `stateTrim`
(drops the oldest list entries first to fit the checkpoint budget) and reports
`truncation` / `stateTrimmed`. `describe()` advertises the configured
checkpoint's token budgets (`headTokens` 192 english / 256 multilingual) so
callers can choose compact question wording.

### Measured: not a conversation judge (yet)

`tools/calibrate_jev.py` scores the checkpoint on the reply copilot's
`jev-judge/v1` question set with jev-chat-jarvis's 30-case labeled set
(vendored in `tools/fixtures/`, MIT) against Jarvis's acceptance bar
(danger MAE < 1.0, intent / need hit rate ≥ 60%). Zero-shot results
(2026-09-25, Apple Silicon, `checkpoint: auto` → multilingual):

| Question           | Compact wording | Full wording | Bar   |
| ------------------ | --------------- | ------------ | ----- |
| `true_intent`      | 23%             | 17%          | ≥ 60% |
| `she_needs`        | 37%             | 27%          | ≥ 60% |
| `danger_level` MAE | 2.28            | 2.18         | < 1.0 |
| `best_action`      | 33%             | 27%          | —     |
| `literal_question` | 37%             | 30%          | —     |
| `should_reply_now` | 57%             | 47%          | —     |
| `tension_resolved` | 57%             | 67%          | —     |

Six-way intent at 17–23% is chance. The provider therefore declares no
`validatedQuestionSets`, and the copilot neither judges nor ranks with it
(it says so in the panel and still drafts). Re-run after a checkpoint change:

```bash
plugins/cognia-laya-guard/.venv/bin/python plugins/cognia-laya-guard/tools/calibrate_jev.py
```

## Checkpoint routing

Default `checkpoint: "auto"` uses laya's `Router` — it detects script/language
per request (<0.5 ms) and dispatches to the English or multilingual checkpoint
as appropriate. The Router is lazy by itself, so the loader **preloads both
checkpoints on a background thread** and only reports `ready` once they are
built (~60 s from a warm cache on Apple Silicon); nothing downloads inside a
hook call. This matters: the English checkpoint misfires badly on text it
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
- **laya truncates silently, so `decide` measures first.** Each option is
  capped at 48 tokens, instructions are cut to fit the head budget (192 tokens
  english, 256 multilingual), and the state is cut from the _tail_ — for a
  chat that drops the newest messages. `decide` replays that packing against
  the routed checkpoint, trims the oldest entries of an optional `stateTrim`
  path first, and reports `truncation` per question plus `stateTrimmed` /
  `stateTruncated` instead of hiding the cut.

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
- `connectors:read` — the `onConnectorInbound` hook reads the text of every
  inbound IM message to score it. Scoring is local; the text never leaves
  this computer.
- `decisions:provide` — offers `laya-local` as a decision provider.
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
While `ready: false`, inbound messages pass through unmoderated. After a
failure, callers stop re-triggering the load for 5 minutes
(`retryInSeconds`); saving the plugin config or `laya_status(retry: true)`
retries at once. The disk preflight checks every checkpoint the configured
mode needs, not just "some snapshot exists".

## Strings

The label note and the decision provider's status line are translated through
`ctx.i18n.t` against this manifest's `i18n.locales` (`en`, `zh-CN`), with the
English text in `main.py`'s `TEXT_DEFAULTS` as the fallback. The language is
re-read when the provider status is shown, when the config is saved, and at
most once a minute on the inbound path (only when a label is about to be
written) — `i18n.onLocaleChange` needs a host-side callback, which a Python
plugin cannot register (ADR-0145).

## Development

```bash
# unit tests (stubbed agent + fake laya module, no torch, no model download)
pnpm plugin:laya-guard:test

# plugin gates
cognia plugin lint && cognia plugin build
```
