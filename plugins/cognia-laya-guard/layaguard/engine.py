"""Lazy, fail-open wrapper around the `laya` decision engine.

Two jobs share one checkpoint handle:

* **Inbound moderation** for connector (IM) messages — the task where the base
  laya checkpoint measured well on real inference (spam 1.0 / clean ≤0.06
  across en+zh samples). The prompt-guardrail surface was removed after
  validation showed the zero-shot checkpoint false-positives ~1.0 on ordinary
  technical text (system prompts, diffs, .env files).
* **Typed decisions** (`decide`) — the host's local System-1 provider
  (`ctx.decisions`, ADR-0193): arbitrary `noul` / `choice` / `score` questions
  over a state object, answered in one forward pass.

Properties that shape everything here:

* Loading is expensive (first call downloads ~1.3 GB of weights), so it always
  happens on a daemon thread, and for ``checkpoint: "auto"`` the loader
  *preloads* the english + multilingual checkpoints — ``laya.Router`` is lazy
  and would otherwise download inside the first ``predict``. A caller that
  arrives while loading gets "not ready", which every caller maps to allow.
* ``import laya`` happens inside the loader (via ``_import_laya``), not at
  module scope: the host must be able to import ``main.py`` and report a clean
  status before ``pythonDependencies`` are installed, and tests inject a fake.
* Two locks. ``_state_lock`` guards config, counters and the agent handle and
  is only ever held for bookkeeping; ``_infer_lock`` serializes the forward
  pass (``Agent.system_one`` mutates its device/dtype on the OOM fallback and
  MPS is not safe for concurrent submission). Status and configure never wait
  on inference.
* laya truncates silently: options are capped at 48 tokens, instructions are
  cut to fit the head budget, and the state is cut from the *tail* — for a
  chat state that drops the newest messages. ``decide`` measures against the
  routed checkpoint's own budgets, trims the oldest entries of an optional
  ``stateTrim`` path first, and reports what was cut instead of hiding it.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

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
#: on jailbreak-style probes in validation). `subfolders` lists what must be
#: on disk for the spec (None = the bundle repo root, i.e. english).
CHECKPOINTS: Dict[str, Dict[str, Any]] = {
    "english": {"kind": "load", "model_id": "convaiinnovations/laya", "subfolders": [None]},
    "multilingual": {
        "kind": "load",
        "model_id": "convaiinnovations/laya",
        "subfolder": "multilingual",
        "subfolders": ["multilingual"],
    },
    "typed-decisions": {
        "kind": "load",
        "model_id": "convaiinnovations/laya",
        "subfolder": "typed-decisions",
        "subfolders": ["typed-decisions"],
    },
    # The Router never auto-selects typed-decisions (auto_task_detection is
    # off), so preloading english + multilingual covers every routed request.
    "auto": {
        "kind": "router",
        "preload": ["english", "multilingual"],
        "subfolders": [None, "multilingual"],
    },
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
INBOUND_BLOCKERS = ("spam", "threat", "harassment", "toxic")

#: Free disk space needed below the HF cache before a cold download is safe
#: to attempt (weights ~1.3 GB + transient blobs; torch itself is a pip dep).
_MIN_FREE_BYTES = 2 * 1024**3

#: After a failed load, callers stop re-triggering it for this long. Without
#: it every inbound message after a failure would start another download.
RETRY_BACKOFF_SECONDS = 300.0

#: laya's per-option token cap and the head budget floor below which options
#: are shortened evenly (laya/common.py build_sequence).
_OPTION_TOKEN_CAP = 48
_MIN_HEAD_BUDGET = 16
_MIN_INSTRUCTION_TOKENS = 8

_QUESTION_TYPES = ("noul", "choice", "score")
_MAX_CHOICE_OPTIONS = 255


def _import_laya() -> Any:
    """Deferred import seam — heavy (torch) and optional until deps install."""
    import laya

    return laya


def _hf_cache_dir() -> str:
    if os.environ.get("HF_HUB_CACHE"):
        return os.path.expanduser(os.environ["HF_HUB_CACHE"])
    if os.environ.get("HF_HOME"):
        return os.path.join(os.path.expanduser(os.environ["HF_HOME"]), "hub")
    return os.path.expanduser("~/.cache/huggingface/hub")


def _model_snapshot_present(subfolders: List[Optional[str]]) -> bool:
    """True when every checkpoint the spec needs is already in the local HF cache.

    Checks each subfolder's weights file, not "any snapshot exists": a cached
    english checkpoint says nothing about the ~600 MB multilingual one.
    """
    root = os.path.join(_hf_cache_dir(), "models--convaiinnovations--laya", "snapshots")
    try:
        snapshots = [os.path.join(root, name) for name in os.listdir(root)]
    except OSError:
        return False
    for sub in subfolders:
        rel = os.path.join(sub, "model.safetensors") if sub else "model.safetensors"
        if not any(os.path.exists(os.path.join(snap, rel)) for snap in snapshots):
            return False
    return True


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


def validate_questions(questions: Any) -> Optional[str]:
    """Reason the question map is unusable, or None when it is well formed.

    Mirrors the wire contract the host validates too (types/decisions): laya
    would otherwise raise deep inside tokenization, or silently misread a
    malformed criteria block.
    """
    if not isinstance(questions, dict) or not questions:
        return "questions must be a non-empty object"
    for qid, q in questions.items():
        if not isinstance(qid, str) or not qid:
            return "question ids must be non-empty strings"
        if not isinstance(q, dict):
            return f"question {qid!r} must be an object"
        qtype = q.get("type")
        if qtype not in _QUESTION_TYPES:
            return f"question {qid!r} has unknown type {qtype!r}"
        instructions = q.get("instructions")
        if not isinstance(instructions, str) or not instructions.strip():
            return f"question {qid!r} needs non-empty instructions"
        criteria = q.get("criteria")
        if qtype == "choice":
            if not isinstance(criteria, dict) or not 2 <= len(criteria) <= _MAX_CHOICE_OPTIONS:
                return f"choice question {qid!r} needs 2-{_MAX_CHOICE_OPTIONS} criteria"
            if not all(isinstance(k, str) and k for k in criteria):
                return f"choice question {qid!r} has an empty option key"
        elif qtype == "score":
            if not isinstance(criteria, list) or len(criteria) < 2:
                return f"score question {qid!r} needs at least 2 criteria levels"
        elif criteria is not None:
            if not isinstance(criteria, dict) or not set(criteria) <= {"true", "false"}:
                return f"noul question {qid!r} criteria may only carry 'true'/'false'"
    return None


def _render_criterion(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "), default=str)


def _render_options(q: Dict[str, Any]) -> List[str]:
    """Option texts exactly as laya renders them (laya/common.py render_options)."""
    qtype, crit = q["type"], q.get("criteria")
    if qtype == "choice":
        return [
            k if v is None or v == "" else "%s: %s" % (k, _render_criterion(v))
            for k, v in crit.items()
        ]
    if qtype == "score":
        return ["level %d: %s" % (i, _render_criterion(c)) for i, c in enumerate(crit)]
    crit = crit or {}
    false_crit, true_crit = crit.get("false"), crit.get("true")
    return [
        "false: " + (_render_criterion(false_crit) if false_crit not in (None, "") else "no, the statement does not hold"),
        "true: " + (_render_criterion(true_crit) if true_crit not in (None, "") else "yes, the statement holds"),
    ]


def _serialize_state(state: Any) -> str:
    return state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)


def _token_count(tok: Any, text: str) -> int:
    return len(tok(text, add_special_tokens=False)["input_ids"])


def measure_question(tok: Any, question: Dict[str, Any], max_len: int, head_max_len: int) -> Dict[str, int]:
    """Replay laya's head packing for one question (laya/common.py build_sequence).

    Returns the instruction tokens written vs kept, how many options lost
    tokens, and the room left for the state. laya is pinned (==0.3.5), so
    mirroring its arithmetic is exact rather than approximate.
    """
    head = _token_count(tok, "%s question: %s" % (question["type"], question["instructions"]))
    raw = [_token_count(tok, " " + text) for text in _render_options(question)]
    opts = [1 + min(_OPTION_TOKEN_CAP, n) for n in raw]  # 1 = the [MASK] marker
    clipped = sum(1 for n in raw if n > _OPTION_TOKEN_CAP)
    budget = head_max_len - sum(opts)
    if budget < _MIN_HEAD_BUDGET:
        per = max(4, (head_max_len - _MIN_HEAD_BUDGET) // max(1, len(opts)))
        clipped = sum(1 for n in opts if n > per)
        opts = [min(n, per) for n in opts]
        budget = head_max_len - sum(opts)
    kept = min(head, max(_MIN_INSTRUCTION_TOKENS, budget))
    fixed = 1 + kept + 1 + sum(opts) + 1  # [CLS] head [SEP] options [SEP]
    return {
        "instructionTokens": head,
        "instructionTokensKept": kept,
        "optionsClipped": clipped,
        "stateRoom": max(0, max_len - fixed - 1),  # trailing [SEP]
    }


def _get_path(state: Any, path: List[str]) -> Optional[List[Any]]:
    node = state
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node if isinstance(node, list) else None


def _with_path(state: Dict[str, Any], path: List[str], value: List[Any]) -> Dict[str, Any]:
    """Copy of `state` with the list at `path` replaced (shallow copies along the path)."""
    root = dict(state)
    node = root
    for key in path[:-1]:
        node[key] = dict(node[key])
        node = node[key]
    node[path[-1]] = value
    return root


class GuardEngine:
    """Holds the checkpoint; answers moderation verdicts and typed decisions.

    All public methods are safe to call before/while the model loads: they
    report "not ready" instead of blocking. Tests drive it with a stubbed
    ``agent_factory`` (or a fake ``laya`` behind ``_import_laya``) so no
    torch/HF download is needed.
    """

    def __init__(
        self,
        agent_factory: Optional[Callable[[Dict[str, Any]], Any]] = None,
        logger: Optional[Callable[[str], None]] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._state_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._agent: Any = None
        # Load bookkeeping. `_generation` bumps whenever the loaded model is
        # invalidated (checkpoint change, unload); a load publishes only if it
        # still belongs to the current generation.
        self._generation = 0
        self._loading_gen: Optional[int] = None
        self._load_started_at: Optional[float] = None
        self._failed_at: Optional[float] = None
        self._closed = False
        self._error: Optional[str] = None
        self._error_kind: Optional[str] = None
        self._checks = 0
        self._blocks = 0
        self._would_blocks = 0
        self._config = dict(DEFAULT_CONFIG)
        # Injectable for tests; production default loads via `laya`.
        self._agent_factory = agent_factory or self._default_factory
        self._log = logger or (lambda _msg: None)
        self._clock = clock

    # ------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------

    def configure(self, config: Optional[Dict[str, Any]]) -> None:
        merged = dict(DEFAULT_CONFIG)
        for key, value in (config or {}).items():
            if key in merged:
                merged[key] = value
        with self._state_lock:
            checkpoint_changed = merged["checkpoint"] != self._config["checkpoint"]
            self._config = merged
            # A config push is the operator's explicit retry signal.
            self._failed_at = None
        if checkpoint_changed:
            # A new checkpoint invalidates the loaded model; drop it so the
            # next load rebuilds. Fail-open: errors are recorded, never raised.
            self.unload()
            self.request_load()

    @property
    def config(self) -> Dict[str, Any]:
        with self._state_lock:
            return dict(self._config)

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def _default_factory(self, spec: Dict[str, Any]) -> Any:
        # Preflight: a cold load downloads ~1.3 GB into the HF cache. Fail fast
        # with a clear error rather than dying mid-download when the disk
        # cannot hold the weights. Only the real factory does this — injected
        # factories (tests) stay hermetic.
        if not _model_snapshot_present(spec.get("subfolders", [None])):
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
        laya = _import_laya()
        if spec.get("kind") == "router":
            # laya.Router loads lazily — a checkpoint would otherwise download
            # inside the first predict. preload() builds them here, on the
            # loader thread, and raises max_loaded to fit so nothing is evicted.
            names = list(spec.get("preload") or [])
            router = laya.Router(max_loaded=max(1, len(names)))
            router.preload(names)
            return router
        kwargs = {k: v for k, v in spec.items() if k in ("subfolder",)}
        return laya.load(spec["model_id"], **kwargs)

    def request_load(self, force: bool = False) -> bool:
        """Kick off a background load if needed. Returns True when already ready.

        Honors the failure back-off unless ``force``; a load already in flight
        (even one for a superseded checkpoint) is never duplicated — a stale
        load re-requests on completion instead of racing a second download.
        """
        with self._state_lock:
            if self._closed:
                return False
            if self._agent is not None:
                return True
            if self._loading_gen is not None:
                return False
            if (
                not force
                and self._failed_at is not None
                and self._clock() - self._failed_at < RETRY_BACKOFF_SECONDS
            ):
                return False
            gen = self._generation
            spec = CHECKPOINTS.get(self._config["checkpoint"], CHECKPOINTS["auto"])
            self._loading_gen = gen
            self._load_started_at = self._clock()
            self._failed_at = None
            self._error = None
            self._error_kind = None
        thread = threading.Thread(
            target=self._load_body, args=(gen, spec), name="laya-guard-load", daemon=True
        )
        thread.start()
        return False

    def _load_body(self, gen: int, spec: Dict[str, Any]) -> None:
        agent: Any = None
        failure: Optional[BaseException] = None
        try:
            agent = self._agent_factory(spec)
        except Exception as exc:  # fail-open: record, never raise
            failure = exc
        stale = False
        with self._state_lock:
            if self._loading_gen == gen:
                self._loading_gen = None
            if gen != self._generation or self._closed:
                stale = True
            elif failure is not None:
                self._error = f"{type(failure).__name__}: {failure}"
                self._error_kind = _classify_error(failure)
                self._failed_at = self._clock()
            else:
                self._agent = agent
        if stale:
            # Superseded while loading (checkpoint change / unload): discard
            # the result and load what the current generation wants.
            self._release(agent)
            self._log("laya-guard: discarded a load for a superseded checkpoint")
            self.request_load(force=True)
            return
        if failure is not None:
            self._log(f"laya-guard: model load failed: {failure}")
            return
        self._log("laya-guard: checkpoint ready")

    @staticmethod
    def _release(agent: Any) -> None:
        unload = getattr(agent, "unload", None)  # Router releases checkpoints
        if callable(unload):
            try:
                unload()
            except Exception:
                pass

    def unload(self) -> None:
        with self._state_lock:
            agent, self._agent = self._agent, None
            self._generation += 1
            self._error = None
            self._error_kind = None
        self._release(agent)

    def shutdown(self) -> None:
        """Unload for good — a load still in flight is discarded, not retried."""
        with self._state_lock:
            self._closed = True
        self.unload()

    def ready(self) -> bool:
        with self._state_lock:
            return self._agent is not None

    def status(self) -> Dict[str, Any]:
        with self._state_lock:
            now = self._clock()
            loading = self._loading_gen is not None
            backoff = (
                max(0.0, round(RETRY_BACKOFF_SECONDS - (now - self._failed_at), 1))
                if self._failed_at is not None
                else None
            )
            loaded = getattr(self._agent, "loaded", None)
            return {
                "ready": self._agent is not None,
                "loading": loading,
                "checkpoint": self._config["checkpoint"],
                "loadedCheckpoints": list(loaded) if isinstance(loaded, (list, tuple)) else None,
                "error": self._error,
                "errorKind": self._error_kind,
                "retryInSeconds": backoff,
                "checks": self._checks,
                "blocks": self._blocks,
                "wouldBlock": self._would_blocks,
                "loadSeconds": (
                    round(now - self._load_started_at, 1)
                    if loading and self._load_started_at
                    else None
                ),
            }

    # ------------------------------------------------------------------
    # inference
    # ------------------------------------------------------------------

    def _handle(self) -> Any:
        """Current agent handle, kicking off a load when there is none."""
        with self._state_lock:
            agent = self._agent
        if agent is None:
            self.request_load()
        return agent

    @staticmethod
    def _route(handle: Any, state: Any, questions: Dict[str, Any]) -> Tuple[Any, Optional[Dict[str, Any]]]:
        """(agent that will answer, routing decision) — pins the Router's choice
        so the budgets we measure are the ones the answering checkpoint uses."""
        route = getattr(handle, "route", None)
        load = getattr(handle, "load", None)
        if callable(route) and callable(load):
            decision = dict(route(state, questions))
            return load(decision["model"]), decision
        return handle, None

    def _fit_state(
        self,
        agent: Any,
        state: Any,
        questions: Dict[str, Any],
        trim_path: Optional[List[str]],
    ) -> Tuple[Any, Dict[str, Any]]:
        """Trim the oldest entries at `trim_path` until the state fits the
        tightest question's room; report per-question head truncation."""
        tok = getattr(agent, "tok", None)
        cfg = getattr(agent, "cfg", None)
        if tok is None or not isinstance(cfg, dict):
            return state, {}  # a backend without a tokenizer cannot be measured
        max_len = int(cfg.get("max_len", 512))
        head_max_len = int(cfg.get("head_max_len", 192))
        measured = {qid: measure_question(tok, q, max_len, head_max_len) for qid, q in questions.items()}
        room = min(m["stateRoom"] for m in measured.values())
        report: Dict[str, Any] = {}
        truncation = {
            qid: {k: v for k, v in m.items() if k != "stateRoom"}
            for qid, m in measured.items()
            if m["instructionTokensKept"] < m["instructionTokens"] or m["optionsClipped"]
        }
        if truncation:
            report["truncation"] = truncation
        entries = _get_path(state, trim_path) if trim_path else None
        dropped = 0
        if entries is not None and isinstance(state, dict):
            kept = list(entries)
            candidate = state
            while len(kept) > 1 and _token_count(tok, _serialize_state(candidate)) > room:
                kept.pop(0)
                dropped += 1
                candidate = _with_path(state, trim_path, kept)
            state = candidate
        if dropped:
            report["stateTrimmed"] = dropped
        if _token_count(tok, _serialize_state(state)) > room:
            # Still over: laya keeps the head of the state and drops the tail.
            report["stateTruncated"] = True
        return state, report

    def _predict(
        self,
        state: Any,
        questions: Dict[str, Any],
        trim_path: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """One forward pass. None when not ready (fail-open); raises on predict errors."""
        handle = self._handle()
        if handle is None:
            return None
        with self._infer_lock:  # serialize the forward pass only; ~60ms on MPS
            started = time.time()
            agent, routing = self._route(handle, state, questions)
            fitted, report = self._fit_state(agent, state, questions, trim_path)
            if routing is None:
                out = agent.predict(fitted, questions)
                routing = out.get("routing")
            else:
                out = agent.system_one(fitted, questions)
            elapsed_ms = round((time.time() - started) * 1000, 1)
        with self._state_lock:
            self._checks += 1
        result = {"answers": out["answers"], "latencyMs": elapsed_ms}
        if routing:
            result["routing"] = routing
        result.update(report)
        return result

    def moderate(self, text: str) -> Optional[Dict[str, Any]]:
        """Verdict for an inbound connector message. None = not ready.

        Counter-free: only the inbound hook knows whether a flagged message
        was actually dropped, so it records via `record_inbound`.
        """
        if not text or not text.strip():
            return None
        max_chars = int(self.config["maxChars"])
        truncated = len(text) > max_chars
        result = self._predict({"post": text[:max_chars]}, MODERATION_QUESTIONS)
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
        triggered = [name for name in INBOUND_BLOCKERS if scores[name] >= threshold]
        verdict = {
            "block": bool(triggered),
            "scores": {k: round(v, 4) for k, v in scores.items()},
            "triggered": triggered,
            "truncated": truncated or bool(result.get("stateTruncated")),
            "latencyMs": result["latencyMs"],
        }
        routing = result.get("routing")
        if routing:
            verdict["routedTo"] = routing.get("model")
        return verdict

    def record_inbound(self, verdict: Optional[Dict[str, Any]], mode: str) -> None:
        """Count one inbound outcome: `blocks` = dropped, `wouldBlock` = observe hits."""
        if not verdict or not verdict.get("block"):
            return
        with self._state_lock:
            if mode == "enforce":
                self._blocks += 1
            else:
                self._would_blocks += 1

    def decide(
        self,
        state: Any,
        questions: Any,
        state_trim: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Typed decisions as the provider envelope — never raises.

        ``{"ok": True, "answers", "latencyMs", "routing"?, "truncation"?,
        "stateTrimmed"?, "stateTruncated"?}`` or ``{"ok": False, "error":
        {"kind", "message"}}``. Kinds: ``not_ready``, ``invalid_request``,
        ``invalid_question``, ``predict_failed``.
        """
        if state is None or (isinstance(state, (dict, list, str)) and not state):
            return {"ok": False, "error": {"kind": "invalid_request", "message": "state must be non-empty"}}
        if not isinstance(state, (dict, list, str)):
            return {"ok": False, "error": {"kind": "invalid_request", "message": "state must be an object, list or string"}}
        problem = validate_questions(questions)
        if problem:
            return {"ok": False, "error": {"kind": "invalid_question", "message": problem}}
        if state_trim is not None and (
            not isinstance(state_trim, list)
            or not state_trim
            or not all(isinstance(p, str) and p for p in state_trim)
        ):
            return {"ok": False, "error": {"kind": "invalid_request", "message": "stateTrim must be a non-empty list of keys"}}
        try:
            result = self._predict(state, questions, state_trim)
        except Exception as exc:  # laya raises deep inside tokenization/forward
            self._log(f"laya-guard: decide failed: {exc}")
            return {"ok": False, "error": {"kind": "predict_failed", "message": f"{type(exc).__name__}: {exc}"}}
        if result is None:
            status = self.status()
            message = "laya checkpoint is still loading" if status["loading"] else (
                status["error"] or "laya checkpoint is not loaded"
            )
            return {"ok": False, "error": {"kind": "not_ready", "message": message}, "status": status}
        return {"ok": True, **result}
