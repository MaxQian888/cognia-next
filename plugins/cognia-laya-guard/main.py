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

from typing import Any, Dict, Optional

import cognia
from cognia import contribution, get_config, hook, tool

from layaguard import GuardEngine

ENGINE = GuardEngine(logger=cognia.log)


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------


def on_startup() -> None:
    ENGINE.configure(get_config())
    if ENGINE.config["warmup"]:
        ENGINE.request_load()
    cognia.log(f"cognia-laya-guard started: {ENGINE.status()}")


def on_config_updated(config: Dict[str, Any]) -> None:
    ENGINE.configure(config)


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
            # Observe mode: counted into status()["wouldBlock"], but the
            # message passes — shadow-run on real traffic before enforcing.
            cognia.log(f"laya-guard: observe-mode match (not dropped): {verdict['triggered']}")
            return None
        reason = "laya-guard inbound moderation: " + ", ".join(
            f"{name}={verdict['scores'][name]:.2f}" for name in verdict["triggered"]
        ) + f" (threshold {config['inboundThreshold']}, {verdict['latencyMs']} ms)"
        if verdict.get("truncated"):
            reason += " — message was truncated to the head window"
        return {"action": "block", "reason": reason}
    except Exception as exc:
        cognia.log(f"laya-guard: onConnectorInbound failed open: {exc}")
        return None


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
        if status["loading"]:
            return {"ready": False, "loading": True, "message": "laya checkpoint is loading"}
        message = status["error"] or "laya checkpoint is not loaded"
        if status.get("retryInSeconds"):
            message += f" (retrying in {int(status['retryInSeconds'])} s)"
        return {"ready": False, "message": message}
