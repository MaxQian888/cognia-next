"""Laya Guard — local System-1 moderation for inbound connector (IM) messages.

Uses the `laya` checkpoint (declared in ``pythonDependencies``) to answer typed
questions about text in a single encoder forward pass — no LLM call, no network
round-trip after the weights are cached.

Surface:

* ``onConnectorInbound`` — moderates inbound IM messages (Lark/Slack/Discord/
  Telegram) against spam / threat / harassment / toxic before they reach an
  agent. ``inboundMode: "observe"`` (default) scores without dropping and
  accumulates ``wouldBlock`` counters; ``"enforce"`` drops flagged messages.
* Tools — ``laya_status`` (readiness), ``laya_moderate_check`` (same verdict
  as the hook, on arbitrary text), ``laya_decide`` (raw typed questions).

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
from cognia import get_config, hook, tool

from layaguard import GuardEngine

ENGINE = GuardEngine(logger=lambda msg: print(msg))


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------


def on_startup() -> None:
    ENGINE.configure(get_config())
    if ENGINE.config["warmup"]:
        ENGINE.request_load()
    print(f"cognia-laya-guard started: {ENGINE.status()}")


def on_config_updated(config: Dict[str, Any]) -> None:
    ENGINE.configure(config)


def on_shutdown() -> None:
    ENGINE.unload()
    print("cognia-laya-guard shutting down")


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
        if not ENGINE.config["inboundModeration"]:
            return None
        if not isinstance(payload, dict):
            return None
        text = payload.get("plainText")
        if not isinstance(text, str):
            return None
        verdict = ENGINE.moderate(text)
        if verdict is None or not verdict["block"]:
            return None
        if ENGINE.config["inboundMode"] != "enforce":
            # Observe mode: score was recorded into status()["wouldBlock"], but
            # the message passes — shadow-run on real traffic before enforcing.
            print(f"laya-guard: observe-mode match (not dropped): {verdict['triggered']}")
            return None
        reason = "laya-guard inbound moderation: " + ", ".join(
            f"{name}={verdict['scores'][name]:.2f}" for name in verdict["triggered"]
        ) + f" (threshold {ENGINE.config['inboundThreshold']}, {verdict['latencyMs']} ms)"
        if verdict.get("truncated"):
            reason += " — message was truncated to the head window"
        return {"action": "block", "reason": reason}
    except Exception as exc:
        print(f"laya-guard: onConnectorInbound failed open: {exc}")
        return None


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------


@tool(
    name="laya_status",
    description="Report whether the local laya checkpoint is loaded, which checkpoint is configured, and check/block counters.",
)
def laya_status() -> Dict[str, Any]:
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
    description="Ask arbitrary typed questions (choice/score/noul) about a state object in one forward pass. Passthrough to the underlying laya engine — see the laya docs for the question schema.",
    parameters={
        "state": {"type": "object", "required": True, "description": "State fields the questions reference, e.g. {\"post\": \"...\"}"},
        "questions": {"type": "object", "required": True, "description": "Typed questions keyed by answer name"},
    },
)
def laya_decide(state: Dict[str, Any], questions: Dict[str, Any]) -> Dict[str, Any]:
    result = ENGINE.decide(state, questions)
    if result is None:
        return {"ready": False, "status": ENGINE.status()}
    return {"ready": True, "result": result}
