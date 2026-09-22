"""Lazy, fail-open wrapper around the `laya` decision engine.

Scope: inbound connector (IM) message moderation — the one task where the
base laya checkpoint measured well on real inference (spam 1.0 / clean ≤0.06
across en+zh samples). The prompt-guardrail surface was removed after
validation showed the zero-shot checkpoint false-positives ~1.0 on ordinary
technical text (system prompts, diffs, .env files); it cannot separate
"text containing instructions" from "malicious instructions" without
fine-tuning.

The engine owns the checkpoint handle. Two properties shape everything here:

* Loading is expensive (first call downloads ~1.3 GB of weights), so it always
  happens on a daemon thread and a hook that arrives while loading gets
  ``None`` — the caller maps that to allow. A moderation gate that wedges the
  connector pipeline while its model downloads would be worse than none.
* `import laya` happens inside the loader, not at module scope: the host must
  be able to import ``main.py`` (and report a clean status tool) even before
  ``pythonDependencies`` have been installed.

Thread-safety: the Python host invokes tools/hooks on worker threads, so the
load flag and every ``predict`` call sit behind one lock. Inference is ~60 ms
on Apple Silicon — serializing callers is fine.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from typing import Any, Callable, Dict, Optional

# ---------------------------------------------------------------------------
# Question schema (field names match the keys the instructions reference).
# ---------------------------------------------------------------------------

MODERATION_QUESTIONS: Dict[str, Any] = {
    "spam": {
        "type": "noul",
        "instructions": "Is `post` spam or advertising?",
    },
    "toxic": {
        "type": "noul",
        "instructions": "Is `post` toxic: rude, disrespectful or likely to make someone leave the discussion?",
    },
    "harassment": {
        "type": "noul",
        "instructions": "Does `post` target or harass a specific person?",
    },
    "threat": {
        "type": "noul",
        "instructions": "Does `post` threaten violence, harm or intimidation?",
    },
    "severity": {
        "type": "score",
        "instructions": "How severe is any rule-breaking in `post`?",
        "criteria": [
            "no rule-breaking: ordinary on-topic post",
            "mild: rude tone or off-topic, no target",
            "clear violation: insults, harassment or spam aimed at someone",
            "severe: threats, hate speech or calls for violence",
        ],
    },
}

#: Manifest-facing checkpoint aliases -> loader specs. "auto" is the laya
#: Router: it detects script/language in <0.5 ms and dispatches to the
#: checkpoint that can read the input, which is the only safe way to run a
#: moderation gate over mixed-language IM traffic (the english checkpoint
#: misfires on text it cannot read — a benign Chinese message scored 1.0
#: on jailbreak-style probes in validation).
CHECKPOINTS: Dict[str, Dict[str, Any]] = {
    "english": {"kind": "load", "model_id": "convaiinnovations/laya"},
    "multilingual": {"kind": "load", "model_id": "convaiinnovations/laya", "subfolder": "multilingual"},
    "typed-decisions": {"kind": "load", "model_id": "convaiinnovations/laya", "subfolder": "typed-decisions"},
    "auto": {"kind": "router", "max_loaded": 2},
}

DEFAULT_CONFIG: Dict[str, Any] = {
    "checkpoint": "auto",
    "inboundModeration": True,
    # "enforce" drops flagged messages; "observe" scores them but never drops —
    # would-be-blocks land in status()["wouldBlock"]. Run observe first on real
    # traffic to see the score distribution before enforcing on it.
    "inboundMode": "observe",
    # Clean en/zh messages measured <=0.06 on every field; a clearly toxic
    # message scored 0.77 — 0.75 sits in the wide gap between them. Lower it
    # toward 0.5 to also catch the softer threat band.
    "inboundThreshold": 0.75,
    "warmup": True,
    "maxChars": 2800,  # ~700 tokens — the multilingual checkpoint's state budget
}

#: noul fields in MODERATION_QUESTIONS that can drop an inbound message.
_INBOUND_BLOCKERS = ("spam", "threat", "harassment", "toxic")

#: Free disk space needed below the HF cache before a cold download is safe
#: to attempt (weights ~1.3 GB + transient blobs; torch itself is a pip dep).
_MIN_FREE_BYTES = 2 * 1024**3


def _hf_cache_dir() -> str:
    if os.environ.get("HF_HUB_CACHE"):
        return os.path.expanduser(os.environ["HF_HUB_CACHE"])
    if os.environ.get("HF_HOME"):
        return os.path.join(os.path.expanduser(os.environ["HF_HOME"]), "hub")
    return os.path.expanduser("~/.cache/huggingface/hub")


def _model_snapshot_present() -> bool:
    """True when any laya snapshot is already in the local HF cache."""
    root = os.path.join(_hf_cache_dir(), "models--convaiinnovations--laya", "snapshots")
    try:
        return bool(os.listdir(root))
    except OSError:
        return False


def _classify_error(exc: BaseException) -> str:
    """Stable error kinds for `laya_status` — so the UI can tell 'install the
    deps' from 'free some disk' from 'check your network'."""
    if isinstance(exc, ImportError):
        return "deps_missing"
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 28:  # ENOSPC
        return "low_disk"
    name = type(exc).__name__.lower()
    message = str(exc).lower()
    if "no space" in message or "not enough free disk" in message:
        return "low_disk"
    if any(k in name for k in ("offline", "connection", "timeout", "http", "network")) or "hf.co" in message:
        return "download_failed"
    return "load_failed"


def _noul(answer: Dict[str, Any]) -> float:
    """P(true) out of a noul answer; tolerate shape drift as 0."""
    try:
        return float(answer.get("noul", 0.0))
    except (TypeError, ValueError):
        return 0.0


def _score_norm(answer: Dict[str, Any], levels: int) -> float:
    """Expected level normalized to 0..1 (levels = len(criteria))."""
    try:
        return max(0.0, min(1.0, float(answer.get("score", 0.0)) / max(1, levels - 1)))
    except (TypeError, ValueError):
        return 0.0


class GuardEngine:
    """Holds the checkpoint and answers moderation verdicts.

    All public methods are safe to call before/while the model loads: they
    return ``None`` (not ready) instead of blocking. Tests drive it with a
    stubbed ``agent_factory`` so no torch/HF download is needed.
    """

    def __init__(
        self,
        agent_factory: Optional[Callable[[Dict[str, Any]], Any]] = None,
        logger: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._lock = threading.Lock()
        self._agent: Any = None
        self._loading = False
        self._load_started_at: Optional[float] = None
        self._error: Optional[str] = None
        self._error_kind: Optional[str] = None
        self._checks = 0
        self._blocks = 0
        self._would_blocks = 0
        self._config = dict(DEFAULT_CONFIG)
        # Injectable for tests; production default loads via `laya`.
        self._agent_factory = agent_factory or self._default_factory
        self._log = logger or (lambda _msg: None)

    # ------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------

    def configure(self, config: Optional[Dict[str, Any]]) -> None:
        merged = dict(DEFAULT_CONFIG)
        for key, value in (config or {}).items():
            if key in merged:
                merged[key] = value
        with self._lock:
            checkpoint_changed = merged["checkpoint"] != self._config["checkpoint"]
            self._config = merged
        if checkpoint_changed:
            # A new checkpoint invalidates the loaded model; drop it so the
            # next request_load() rebuilds. Fail-open: errors are recorded,
            # never raised into a hook.
            self.unload()
            self.request_load()

    @property
    def config(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._config)

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def _default_factory(self, spec: Dict[str, Any]) -> Any:
        # Preflight: a cold load downloads ~1.3 GB into the HF cache. Fail fast
        # with a clear error rather than dying mid-download when the disk
        # cannot hold the weights. Only the real factory does this — injected
        # factories (tests) stay hermetic.
        if not _model_snapshot_present():
            try:
                free = shutil.disk_usage(os.path.dirname(_hf_cache_dir()) or "/").free
            except OSError:
                free = _MIN_FREE_BYTES  # unknown -> let the download try
            if free < _MIN_FREE_BYTES:
                raise OSError(
                    28,
                    f"insufficient disk space in the HF cache "
                    f"({free // 1024**2} MB free, need ~{_MIN_FREE_BYTES // 1024**3} GB): "
                    f"{_hf_cache_dir()}",
                )
        import laya  # deferred: heavy (torch) and optional until deps install

        if spec.get("kind") == "router":
            # Lazy: checkpoints load on first predict, `max_loaded` bounds how
            # many stay resident (LRU). Language flips cost detection only.
            return laya.Router(max_loaded=int(spec.get("max_loaded", 2)))
        kwargs = {k: v for k, v in spec.items() if k not in ("kind", "model_id")}
        return laya.load(spec["model_id"], **kwargs)

    def request_load(self) -> bool:
        """Kick off a background load if needed. Returns True when already ready."""
        with self._lock:
            if self._agent is not None:
                return True
            if self._loading:
                return False
            self._loading = True
            self._load_started_at = time.time()
            self._error = None
            self._error_kind = None
        thread = threading.Thread(target=self._load_body, name="laya-guard-load", daemon=True)
        thread.start()
        return False

    def _load_body(self) -> None:
        spec = CHECKPOINTS.get(self.config["checkpoint"], CHECKPOINTS["auto"])
        try:
            agent = self._agent_factory(spec)
        except Exception as exc:  # fail-open: record, never raise
            self._log(f"laya-guard: model load failed: {exc}")
            with self._lock:
                self._error = f"{type(exc).__name__}: {exc}"
                self._error_kind = _classify_error(exc)
                self._loading = False
            return
        with self._lock:
            self._agent = agent
            self._loading = False
        self._log("laya-guard: checkpoint ready")

    def unload(self) -> None:
        with self._lock:
            agent, self._agent = self._agent, None
            self._error = None
        unload = getattr(agent, "unload", None)  # Router releases checkpoints
        if callable(unload):
            try:
                unload()
            except Exception:
                pass

    def ready(self) -> bool:
        with self._lock:
            return self._agent is not None

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "ready": self._agent is not None,
                "loading": self._loading,
                "checkpoint": self._config["checkpoint"],
                "error": self._error,
                "errorKind": self._error_kind,
                "checks": self._checks,
                "blocks": self._blocks,
                "wouldBlock": self._would_blocks,
                "loadSeconds": (
                    round(time.time() - self._load_started_at, 1)
                    if self._loading and self._load_started_at
                    else None
                ),
            }

    # ------------------------------------------------------------------
    # inference
    # ------------------------------------------------------------------

    def _predict(self, state: Dict[str, Any], questions: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """One forward pass over the head window. None when not ready (fail-open)."""
        with self._lock:
            agent = self._agent
        if agent is None:
            self.request_load()
            return None
        max_chars = int(self.config["maxChars"])
        truncated = any(isinstance(v, str) and len(v) > max_chars for v in state.values())
        clipped = {
            key: (value[:max_chars] if isinstance(value, str) else value)
            for key, value in state.items()
        }
        with self._lock:  # serialize predict; ~60ms on MPS
            started = time.time()
            out = agent.predict(clipped, questions)
            elapsed_ms = round((time.time() - started) * 1000, 1)
        with self._lock:
            self._checks += 1
        return {
            "answers": out["answers"],
            "routing": out.get("routing"),  # present when checkpoint="auto"
            "truncated": truncated,
            "latencyMs": elapsed_ms,
        }

    def moderate(self, text: str) -> Optional[Dict[str, Any]]:
        """Verdict for an inbound connector message. None = not ready."""
        if not text or not text.strip():
            return None
        result = self._predict({"post": text}, MODERATION_QUESTIONS)
        if result is None:
            return None
        answers = result["answers"]
        scores = {
            "spam": _noul(answers.get("spam", {})),
            "toxic": _noul(answers.get("toxic", {})),
            "harassment": _noul(answers.get("harassment", {})),
            "threat": _noul(answers.get("threat", {})),
            "severity": _score_norm(
                answers.get("severity", {}), len(MODERATION_QUESTIONS["severity"]["criteria"])
            ),
        }
        threshold = float(self.config["inboundThreshold"])
        triggered = [name for name in _INBOUND_BLOCKERS if scores[name] >= threshold]
        verdict = {
            "block": bool(triggered),
            "scores": {k: round(v, 4) for k, v in scores.items()},
            "triggered": triggered,
            "truncated": result["truncated"],
            "latencyMs": result["latencyMs"],
        }
        if result.get("routing"):
            verdict["routedTo"] = result["routing"].get("model")
        if verdict["block"]:
            with self._lock:
                self._blocks += 1
                if self._config["inboundMode"] == "observe":
                    self._would_blocks += 1
        return verdict

    def decide(self, state: Dict[str, Any], questions: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Raw passthrough for ad-hoc typed questions (the `laya_decide` tool)."""
        if not isinstance(state, dict) or not isinstance(questions, dict) or not questions:
            return {"error": "state and questions must be non-empty objects"}
        result = self._predict(state, questions)
        if result is None:
            return None
        return result
