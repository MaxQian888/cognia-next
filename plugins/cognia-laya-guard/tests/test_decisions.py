"""The ``laya-local`` decision provider contribution (ADR-0194).

Driven through the SDK runtime's own dispatcher — the offline twin of the
host's ``__cognia_dispatch_contribution__`` — so the test proves the object the
host will actually reach, not just the class.
"""

from __future__ import annotations

from cognia.runtime import get_active_runtime

import main

REQUEST = {
    "state": {"chat": {"messages": [{"from": "other", "text": "hi"}]}},
    "questions": {"tense": {"type": "noul", "instructions": "Is there tension?"}},
    "stateTrim": ["chat", "messages"],
}


class StubEngine:
    def __init__(self, decide_result=None, status=None, checkpoint="auto"):
        self.decide_result = decide_result or {"ok": True, "answers": {"tense": {"noul": 0.2}}, "latencyMs": 40.0}
        self._status = status or {"ready": True, "loading": False, "error": None, "retryInSeconds": None}
        self.config = {"checkpoint": checkpoint}
        self.calls = []

    def decide(self, state, questions, state_trim=None):
        self.calls.append((state, questions, state_trim))
        return dict(self.decide_result)

    def status(self):
        return dict(self._status)


def dispatch(method, *args):
    return get_active_runtime().dispatch_contribution("laya-local", method, list(args))


def test_describe_reports_local_calibrated_and_checkpoint_budgets(monkeypatch):
    monkeypatch.setattr(main, "ENGINE", StubEngine(checkpoint="auto"))
    assert dispatch("describe") == {
        "locality": "local",
        "calibrated": True,
        "limits": {"headTokens": 192, "inputTokens": 512, "optionTokens": 48},
    }
    monkeypatch.setattr(main, "ENGINE", StubEngine(checkpoint="multilingual"))
    assert dispatch("describe")["limits"]["headTokens"] == 256


def test_decide_forwards_state_questions_and_trim(monkeypatch):
    engine = StubEngine()
    monkeypatch.setattr(main, "ENGINE", engine)
    out = dispatch("decide", REQUEST)
    assert out["ok"] is True
    assert engine.calls == [(REQUEST["state"], REQUEST["questions"], ["chat", "messages"])]


def test_decide_strips_status_from_not_ready_envelopes(monkeypatch):
    engine = StubEngine(
        decide_result={"ok": False, "error": {"kind": "not_ready", "message": "loading"}, "status": {"x": 1}}
    )
    monkeypatch.setattr(main, "ENGINE", engine)
    out = dispatch("decide", REQUEST)
    assert out == {"ok": False, "error": {"kind": "not_ready", "message": "loading"}}


def test_decide_rejects_non_object_requests(monkeypatch):
    monkeypatch.setattr(main, "ENGINE", StubEngine())
    out = dispatch("decide", "nope")
    assert out["ok"] is False and out["error"]["kind"] == "invalid_request"


def test_status_maps_engine_state(monkeypatch):
    monkeypatch.setattr(main, "ENGINE", StubEngine())
    assert dispatch("status") == {"ready": True}
    monkeypatch.setattr(
        main, "ENGINE", StubEngine(status={"ready": False, "loading": True, "error": None, "retryInSeconds": None})
    )
    assert dispatch("status") == {"ready": False, "loading": True, "message": "laya checkpoint is loading"}
    monkeypatch.setattr(
        main,
        "ENGINE",
        StubEngine(status={"ready": False, "loading": False, "error": "OSError: disk", "retryInSeconds": 120.0}),
    )
    assert dispatch("status") == {"ready": False, "message": "OSError: disk (retrying in 120 s)"}
