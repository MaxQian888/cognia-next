"""Hook payload contracts and fail-open behavior on `main`'s wiring.

`main.py` is imported directly — the `cognia` SDK registers the decorators into
its module-local runtime without needing a host. `main.ENGINE` is swapped for a
stub so no model is loaded.
"""

from __future__ import annotations

import main


class StubEngine:
    def __init__(self, verdict=None, config=None, raises=False):
        self.verdict = verdict
        self.raises = raises
        self._config = {
            "checkpoint": "auto",
            "inboundModeration": True,
            "inboundMode": "observe",
            "inboundThreshold": 0.75,
            "warmup": False,
            "maxChars": 2800,
        }
        self._config.update(config or {})
        self.recorded = []
        self.forced_loads = 0

    @property
    def config(self):
        return dict(self._config)

    def configure(self, config):
        self._config.update({k: v for k, v in (config or {}).items() if k in self._config})

    def moderate(self, text):
        if self.raises:
            raise RuntimeError("boom")
        return self.verdict

    def record_inbound(self, verdict, mode):
        self.recorded.append((verdict, mode))

    def decide(self, state, questions, state_trim=None):
        return {"ok": True, "answers": {}, "latencyMs": 1.0}

    def status(self):
        return {"ready": True, "loading": False, "checkpoint": "auto", "error": None}

    def request_load(self, force=False):
        if force:
            self.forced_loads += 1
        return True

    def unload(self):
        pass

    def shutdown(self):
        pass


MOD_BLOCK_VERDICT = {
    "block": True,
    "scores": {"spam": 0.96, "toxic": 0.2, "harassment": 0.1, "threat": 0.05, "severity": 0.3},
    "triggered": ["spam"],
    "truncated": False,
    "latencyMs": 55.0,
}

MOD_ALLOW_VERDICT = {
    "block": False,
    "scores": {"spam": 0.02, "toxic": 0.05, "harassment": 0.0, "threat": 0.01, "severity": 0.1},
    "triggered": [],
    "truncated": False,
    "latencyMs": 58.0,
}


def _swap(monkeypatch, engine):
    monkeypatch.setattr(main, "ENGINE", engine)
    return engine


# ---------------------------------------------------------------------------
# onConnectorInbound
# ---------------------------------------------------------------------------


def _inbound(text="buy my tokens"):
    return {
        "adapterId": "lark-1",
        "conversationKey": "conv-1",
        "platform": "lark",
        "segments": [],
        "plainText": text,
        "messageId": "m-1",
    }


def test_inbound_observe_default_allows_but_counts(monkeypatch):
    # Observe is the install default: a flag-worthy message still passes, and
    # the hook (not moderate()) records it as a would-be block.
    engine = _swap(monkeypatch, StubEngine(verdict=MOD_BLOCK_VERDICT))
    assert main.moderate_inbound(_inbound()) is None
    assert engine.recorded == [(MOD_BLOCK_VERDICT, "observe")]


def test_inbound_enforce_blocks(monkeypatch):
    engine = _swap(
        monkeypatch,
        StubEngine(verdict=MOD_BLOCK_VERDICT, config={"inboundMode": "enforce"}),
    )
    result = main.moderate_inbound(_inbound())
    assert result["action"] == "block"
    assert "spam=0.96" in result["reason"]
    assert "laya-guard" in result["reason"]
    assert engine.recorded == [(MOD_BLOCK_VERDICT, "enforce")]


def test_inbound_disabled_allows(monkeypatch):
    _swap(monkeypatch, StubEngine(verdict=MOD_BLOCK_VERDICT, config={"inboundModeration": False}))
    assert main.moderate_inbound(_inbound()) is None


def test_inbound_clean_allows(monkeypatch):
    _swap(monkeypatch, StubEngine(verdict=MOD_ALLOW_VERDICT))
    assert main.moderate_inbound(_inbound()) is None


def test_inbound_not_ready_allows(monkeypatch):
    _swap(monkeypatch, StubEngine(verdict=None))  # model still loading
    assert main.moderate_inbound(_inbound()) is None


def test_inbound_malformed_allows(monkeypatch):
    _swap(monkeypatch, StubEngine(verdict=MOD_BLOCK_VERDICT))
    assert main.moderate_inbound(None) is None
    assert main.moderate_inbound({"no": "text"}) is None
    assert main.moderate_inbound({"plainText": 123}) is None


def test_inbound_engine_error_fails_open(monkeypatch):
    _swap(monkeypatch, StubEngine(raises=True))
    assert main.moderate_inbound(_inbound()) is None


def test_inbound_reason_marks_truncation(monkeypatch):
    verdict = dict(MOD_BLOCK_VERDICT, truncated=True)
    _swap(monkeypatch, StubEngine(verdict=verdict, config={"inboundMode": "enforce"}))
    result = main.moderate_inbound(_inbound())
    assert "truncated" in result["reason"]


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------


def test_laya_status_shape(monkeypatch):
    engine = _swap(monkeypatch, StubEngine())
    status = main.laya_status()
    assert status["ready"] is True
    assert status["checkpoint"] == "auto"
    assert engine.forced_loads == 0


def test_laya_status_retry_forces_a_load(monkeypatch):
    engine = _swap(monkeypatch, StubEngine())
    main.laya_status(retry=True)
    assert engine.forced_loads == 1


def test_laya_moderate_check_not_ready(monkeypatch):
    _swap(monkeypatch, StubEngine(verdict=None))
    out = main.laya_moderate_check("hello")
    assert out["ready"] is False
    assert "status" in out


def test_laya_moderate_check_verdict(monkeypatch):
    _swap(monkeypatch, StubEngine(verdict=MOD_BLOCK_VERDICT))
    out = main.laya_moderate_check("buy now")
    assert out["ready"] is True
    assert out["verdict"]["block"] is True


def test_laya_decide_passthrough(monkeypatch):
    _swap(monkeypatch, StubEngine())
    out = main.laya_decide({"post": "hi"}, {"q": {"type": "noul", "instructions": "?"}})
    assert out["ok"] is True
    assert "answers" in out


def test_laya_decide_not_ready(monkeypatch):
    class NotReady(StubEngine):
        def decide(self, state, questions, state_trim=None):
            return {"ok": False, "error": {"kind": "not_ready", "message": "loading"}}

    _swap(monkeypatch, NotReady())
    out = main.laya_decide({"post": "hi"}, {"q": {}})
    assert out["ok"] is False
    assert out["error"]["kind"] == "not_ready"
