"""Laya (local System-1) — inbound IM moderation and typed decisions for Cognia.

Uses the `laya` checkpoint (declared in ``pythonDependencies``) to answer typed
questions about text in a single encoder forward pass — no LLM call, no network
round-trip after the weights are cached.

Surface:

* ``onConnectorInbound`` — moderates inbound IM messages (Lark/Slack/Discord/
  Telegram) against spam / threat / harassment / toxic before they reach an
  agent. ``inboundMode: "observe"`` (default) scores without dropping and
  accumulates ``wouldBlock`` counters; ``"enforce"`` drops flagged messages.
* Tools — ``laya_status`` (readiness, optional retry), ``laya_moderate_check``
  (same verdict as the hook, on arbitrary text), ``laya_decide`` (raw typed
  questions).
* Decision provider ``laya-local`` (ADR-0194) — the host's local System-1
  backend for ``ctx.decisions`` and the IM reply copilot. The host redacts and
  PII-gates every request before it reaches ``decide``.

Everything fails open: while the checkpoint is still loading (first run pulls
~1.3 GB from HuggingFace) or on any error, messages are allowed through rather
than dropped. ``laya_status`` reports readiness.

Why this scope: real-inference validation showed the base checkpoint reliable
for short-message moderation (spam 1.0 vs clean ≤0.06 on en+zh samples) but
not for prompt-injection guarding — it flags ordinary technical text
(system prompts, diffs, .env files) at ~1.0. The prompt-guard hook was
removed rather than shipped as a broken feature; see README for the data.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any, Dict, Optional

import cognia
from cognia import contribution, get_config, hook, tool

from layaguard import GuardEngine

ENGINE = GuardEngine(logger=cognia.log)


# ---------------------------------------------------------------------------
# user-facing text
# ---------------------------------------------------------------------------

#: Every string this plugin paints into the host UI — the hover note on an
#: observe-mode inbound label and the decision provider's status line in
#: Settings → Conversation — with its English default. The translations live in
#: plugin.json ``i18n.locales``; ``ctx.i18n.t`` resolves them against this
#: plugin's own bundle (locale → en → key), and ``{name}`` placeholders are
#: filled here so a template is fetched once rather than per message.
TEXT_DEFAULTS: Dict[str, str] = {
    "inbound.observeNote": "laya observe mode · threshold {threshold}",
    "inbound.truncatedNote": "message truncated to the head window",
    "status.loading": "laya checkpoint is loading",
    "status.notLoaded": "laya checkpoint is not loaded",
    "status.retrying": "{message} (retrying in {seconds} s)",
}

#: Seconds between locale re-checks on the inbound path. ``i18n.onLocaleChange``
#: registers a host-side callback, which cannot cross the stdio boundary
#: (ADR-0145), so the language is polled instead — at most once a minute, and
#: only when a label is about to be written, never per clean message.
TEXT_REFRESH_SECONDS = 60.0

#: Bound on each ``ctx.i18n`` round trip. A host that does not answer must not
#: stall an inbound message; the English default is the fallback.
_TEXT_CALL_TIMEOUT = 2.0

#: Injected so tests can move time without patching the ``time`` module the
#: event loop also reads.
_clock = time.monotonic

_TEXT: Dict[str, str] = dict(TEXT_DEFAULTS)
_TEXT_STATE: Dict[str, Any] = {"locale": None, "checkedAt": None}
_TEXT_LOCK = threading.Lock()
_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def refresh_text() -> None:
    """Re-read this plugin's strings in the app's current language.

    Called from synchronous code only — the host runs sync hooks, tools and
    contribution methods on a worker thread, which is where
    ``cognia.ctx.run_sync`` is allowed to block. Any failure (no host attached,
    a headless host with no i18n namespace, a timeout) leaves the current table
    in place: English by default, never a raw dotted key.
    """
    with _TEXT_LOCK:
        _TEXT_STATE["checkedAt"] = _clock()
    try:
        locale = str(
            cognia.ctx.run_sync(cognia.ctx.i18n.getCurrentLocale(), timeout=_TEXT_CALL_TIMEOUT)
            or ""
        )
    except Exception as exc:  # noqa: BLE001 — English is the fallback, not an error
        cognia.log(f"laya-guard: i18n unavailable ({exc}); strings stay English")
        return
    with _TEXT_LOCK:
        if locale == _TEXT_STATE["locale"]:
            return
    resolved = dict(TEXT_DEFAULTS)
    for key in TEXT_DEFAULTS:
        try:
            value = cognia.ctx.run_sync(cognia.ctx.i18n.t(key), timeout=_TEXT_CALL_TIMEOUT)
        except Exception as exc:  # noqa: BLE001 — per key: one miss keeps its default
            cognia.log(f"laya-guard: i18n.t({key}) failed: {exc}")
            continue
        # `t` echoes the key back when nothing resolved it; that is not a string.
        if isinstance(value, str) and value and value != key:
            resolved[key] = value
    with _TEXT_LOCK:
        _TEXT.clear()
        _TEXT.update(resolved)
        _TEXT_STATE["locale"] = locale


def _refresh_text_if_due() -> None:
    with _TEXT_LOCK:
        checked_at = _TEXT_STATE["checkedAt"]
    if checked_at is None or _clock() - checked_at >= TEXT_REFRESH_SECONDS:
        refresh_text()


def text(key: str, **params: Any) -> str:
    """The current translation of ``key`` with ``{name}`` placeholders filled."""
    with _TEXT_LOCK:
        template = _TEXT.get(key) or TEXT_DEFAULTS[key]
    return _PLACEHOLDER.sub(
        lambda match: str(params[match.group(1)]) if match.group(1) in params else match.group(0),
        template,
    )


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------


def on_startup() -> None:
    ENGINE.configure(get_config())
    if ENGINE.config["warmup"]:
        ENGINE.request_load()
    refresh_text()
    cognia.log(f"cognia-laya-guard started: {ENGINE.status()}")


def on_config_updated(config: Dict[str, Any]) -> None:
    ENGINE.configure(config)
    refresh_text()


def on_shutdown() -> None:
    ENGINE.shutdown()
    cognia.log("cognia-laya-guard shutting down")


# ---------------------------------------------------------------------------
# hooks
# ---------------------------------------------------------------------------


@hook("onConnectorInbound")
def moderate_inbound(payload: Any) -> Optional[Dict[str, Any]]:
    """Drop spam/threatening inbound IM messages when enabled.

    Payload is a single dict (adapterId, conversationKey, platform, segments,
    plainText, messageId). Returns the ConnectorHookDecision shape; ``None``
    and ``allow`` are equivalent — the bus treats errors/None as allow.
    """
    try:
        config = ENGINE.config
        if not config["inboundModeration"]:
            return None
        if not isinstance(payload, dict):
            return None
        text = payload.get("plainText")
        if not isinstance(text, str):
            return None
        verdict = ENGINE.moderate(text)
        mode = config["inboundMode"]
        ENGINE.record_inbound(verdict, mode)
        if verdict is None or not verdict["block"]:
            return None
        if mode != "enforce":
            # Observe mode: counted into status()["wouldBlock"], and the
            # message passes with the scores attached as labels (ADR-0194) so
            # the operator sees them on the message while shadow-running.
            cognia.log(f"laya-guard: observe-mode match (not dropped): {verdict['triggered']}")
            return {"action": "annotate", "labels": observe_labels(verdict, config)}
        reason = "laya-guard inbound moderation: " + ", ".join(
            f"{name}={verdict['scores'][name]:.2f}" for name in verdict["triggered"]
        ) + f" (threshold {config['inboundThreshold']}, {verdict['latencyMs']} ms)"
        if verdict.get("truncated"):
            reason += " — message was truncated to the head window"
        return {"action": "block", "reason": reason}
    except Exception as exc:
        cognia.log(f"laya-guard: onConnectorInbound failed open: {exc}")
        return None


#: Literal fallbacks only. All four keys are in the host's
#: ``KNOWN_INBOUND_LABEL_KEYS``, so the chip itself is translated by the host;
#: the literal is what a paired companion device (which never loads plugins)
#: would show if that list ever shrank.
_LABEL_TEXT = {"spam": "Spam", "toxic": "Toxic", "harassment": "Harassment", "threat": "Threat"}


def observe_labels(verdict: Dict[str, Any], config: Dict[str, Any]) -> list:
    """Inbound labels for the fields that crossed the threshold (host-translated keys).

    The hover ``note`` is this plugin's own prose, so it is translated here
    (``inbound.*`` in plugin.json) in the app's language at the time the
    message arrived — the label is persisted on the message row.
    """
    _refresh_text_if_due()
    note = text("inbound.observeNote", threshold=config["inboundThreshold"])
    if verdict.get("truncated"):
        note += " · " + text("inbound.truncatedNote")
    return [
        {
            "key": name,
            "score": verdict["scores"][name],
            "label": _LABEL_TEXT.get(name, name),
            "note": note,
        }
        for name in verdict["triggered"]
    ]


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------


@tool(
    name="laya_status",
    description="Report whether the local laya checkpoint is loaded, which checkpoint is configured, and check/block counters. Pass retry=true to retry a failed load immediately instead of waiting out the back-off.",
    parameters={
        "retry": {"type": "boolean", "required": False, "description": "Retry a failed load now"},
    },
)
def laya_status(retry: bool = False) -> Dict[str, Any]:
    if retry:
        ENGINE.request_load(force=True)
    return ENGINE.status()


@tool(
    name="laya_moderate_check",
    description="Run the inbound-moderation questions against arbitrary text and return scores for spam/toxic/harassment/threat/severity.",
    parameters={
        "text": {"type": "string", "required": True, "description": "Text to moderate"},
    },
)
def laya_moderate_check(text: str) -> Dict[str, Any]:
    verdict = ENGINE.moderate(text)
    if verdict is None:
        return {"ready": False, "status": ENGINE.status()}
    return {"ready": True, "verdict": verdict}


@tool(
    name="laya_decide",
    description="Ask arbitrary typed questions (choice/score/noul) about a state object in one forward pass. Returns {ok, answers, latencyMs, routing?, truncation?} or {ok: false, error: {kind, message}}.",
    parameters={
        "state": {"type": "object", "required": True, "description": "State fields the questions reference, e.g. {\"post\": \"...\"}"},
        "questions": {"type": "object", "required": True, "description": "Typed questions keyed by answer name"},
    },
)
def laya_decide(state: Dict[str, Any], questions: Dict[str, Any]) -> Dict[str, Any]:
    return ENGINE.decide(state, questions)


# ---------------------------------------------------------------------------
# decision provider (ADR-0194)
# ---------------------------------------------------------------------------

#: Head / sequence budgets per checkpoint (the checkpoints' rl_agent_config).
#: `auto` routes to either, so it advertises the tighter english budget.
_CHECKPOINT_LIMITS: Dict[str, Dict[str, int]] = {
    "english": {"headTokens": 192, "inputTokens": 512, "optionTokens": 48},
    "multilingual": {"headTokens": 256, "inputTokens": 1024, "optionTokens": 48},
    "typed-decisions": {"headTokens": 256, "inputTokens": 1024, "optionTokens": 48},
}


def _limits() -> Dict[str, int]:
    return dict(_CHECKPOINT_LIMITS.get(ENGINE.config["checkpoint"], _CHECKPOINT_LIMITS["english"]))


@contribution("laya-local")
class LayaDecisionProvider:
    """``manifest.decisionProviders[laya-local]`` — typed decisions on this machine."""

    def describe(self) -> Dict[str, Any]:
        # No `validatedQuestionSets`: measured on the reply copilot's
        # "jev-judge/v1" set (tools/calibrate_jev.py) the zero-shot checkpoint
        # scores near chance, so the copilot will not use it to judge or rank.
        # Add a set here only after a calibration run passes its bar.
        return {"locality": "local", "calibrated": True, "limits": _limits()}

    def decide(self, request: Any) -> Dict[str, Any]:
        if not isinstance(request, dict):
            return {"ok": False, "error": {"kind": "invalid_request", "message": "request must be an object"}}
        result = ENGINE.decide(request.get("state"), request.get("questions"), request.get("stateTrim"))
        result.pop("status", None)  # host reads readiness through status()
        return result

    def status(self) -> Dict[str, Any]:
        status = ENGINE.status()
        if status["ready"]:
            return {"ready": True}
        # The host asks when it is about to show the provider (Settings →
        # Conversation), which is the moment the language is worth re-reading.
        refresh_text()
        if status["loading"]:
            return {"ready": False, "loading": True, "message": text("status.loading")}
        # `error` is the engine's own diagnostic (an exception string) — data
        # relayed as-is; only the wording around it is ours to translate.
        message = status["error"] or text("status.notLoaded")
        if status.get("retryInSeconds"):
            message = text("status.retrying", message=message, seconds=int(status["retryInSeconds"]))
        return {"ready": False, "message": message}
