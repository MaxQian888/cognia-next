"""Engine behavior, driven by a stubbed agent factory — no torch, no HF download."""

from __future__ import annotations

import time

import pytest

from layaguard import GuardEngine
from layaguard.engine import MODERATION_QUESTIONS


class FakeAgent:
    """Answers canned scores keyed by the question name."""

    def __init__(self, scores):
        self.scores = scores
        self.calls = []

    def predict(self, state, questions):
        self.calls.append({"state": state, "questions": questions})
        answers = {}
        for name, q in questions.items():
            value = self.scores.get(name, 0.0)
            if q["type"] == "noul":
                answers[name] = {"noul": value, "confidence": 0.9}
            elif q["type"] == "score":
                answers[name] = {"score": value, "confidence": 0.9}
            else:
                answers[name] = {"choice": "other", "confidence": 0.9}
        return {"answers": answers}


class FakeRouter(FakeAgent):
    """Adds the `routing` key the laya Router returns."""

    def predict(self, state, questions):
        out = super().predict(state, questions)
        out["routing"] = {"model": "multilingual", "reason": "non-Latin script"}
        return out


def make_engine(scores=None, wait=True, agent=None, **config):
    agent = agent or FakeAgent(scores or {})
    engine = GuardEngine(agent_factory=lambda spec: agent)
    if config:
        engine.configure(config)
    engine.request_load()
    if wait:
        for _ in range(200):
            if engine.ready():
                break
            time.sleep(0.01)
    return engine, agent


def test_not_ready_fails_open_and_kicks_load():
    engine = GuardEngine(agent_factory=lambda spec: FakeAgent({}))
    assert engine.ready() is False
    assert engine.moderate("buy my tokens") is None  # triggers load, no block
    for _ in range(200):
        if engine.ready():
            break
        time.sleep(0.01)
    assert engine.ready() is True
    assert engine.moderate("hello") is not None


def test_moderate_blocks_spam():
    engine, _ = make_engine({"spam": 0.99})
    verdict = engine.moderate("BUY NOW!!!")
    assert verdict["block"] is True
    assert "spam" in verdict["triggered"]
    assert verdict["scores"]["spam"] == pytest.approx(0.99)
    assert engine.status()["blocks"] == 1


def test_observe_mode_counts_would_blocks():
    # Default inboundMode is observe: verdicts still flag, and the counter
    # records what enforce would have dropped.
    engine, _ = make_engine({"spam": 0.99})
    assert engine.config["inboundMode"] == "observe"
    assert engine.moderate("BUY NOW")["block"] is True
    assert engine.status()["wouldBlock"] == 1
    engine.configure({"inboundMode": "enforce"})
    assert engine.moderate("BUY NOW")["block"] is True
    assert engine.status()["wouldBlock"] == 1  # enforce increments blocks only
    assert engine.status()["blocks"] == 2


def test_moderate_clean_message_passes():
    engine, _ = make_engine({})
    verdict = engine.moderate("standup notes are posted")
    assert verdict["block"] is False
    assert verdict["triggered"] == []


def test_moderate_severity_normalized_to_unit():
    engine, _ = make_engine({"severity": 3.0})
    verdict = engine.moderate("x")
    assert verdict["scores"]["severity"] == pytest.approx(1.0)


def test_moderate_threshold_configurable():
    engine, _ = make_engine({"toxic": 0.8})
    assert engine.moderate("x")["block"] is True  # 0.8 >= default 0.75
    engine.configure({"inboundThreshold": 0.9})
    assert engine.moderate("x")["block"] is False


def test_router_verdict_carries_routed_model():
    engine, _ = make_engine(agent=FakeRouter({"spam": 0.99}))
    verdict = engine.moderate("垃圾广告")
    assert verdict["block"] is True
    assert verdict["routedTo"] == "multilingual"


def test_load_failure_is_recorded_and_fails_open():
    def boom(spec):
        raise RuntimeError("no weights")

    engine = GuardEngine(agent_factory=boom)
    engine.request_load()
    for _ in range(200):
        if engine.status()["error"]:
            break
        time.sleep(0.01)
    assert engine.ready() is False
    assert "no weights" in engine.status()["error"]
    assert engine.status()["errorKind"] == "load_failed"
    assert engine.moderate("anything") is None


def test_error_kind_classification():
    def engine_raising(exc):
        engine = GuardEngine(agent_factory=lambda spec: (_ for _ in ()).throw(exc))
        engine.request_load()
        for _ in range(200):
            if engine.status()["error"]:
                break
            time.sleep(0.01)
        return engine.status()

    assert engine_raising(ImportError("No module named 'laya'"))["errorKind"] == "deps_missing"
    assert engine_raising(OSError(28, "No space left on device"))["errorKind"] == "low_disk"
    assert engine_raising(OSError("Not enough free disk space to download"))["errorKind"] == "low_disk"
    assert engine_raising(RuntimeError("unexpected"))["errorKind"] == "load_failed"


def test_default_factory_preflights_disk(monkeypatch, tmp_path):
    """Cold load on a nearly-full disk fails fast with low_disk, no download."""
    import layaguard.engine as eng

    monkeypatch.setattr(eng, "_model_snapshot_present", lambda: False)
    monkeypatch.setattr(eng, "_hf_cache_dir", lambda: str(tmp_path))
    monkeypatch.setattr(
        eng.shutil,
        "disk_usage",
        lambda p: type("U", (), {"free": 100 * 1024**2})(),  # 100 MB
    )
    engine = GuardEngine()  # real default factory
    engine.request_load()
    for _ in range(200):
        if engine.status()["error"]:
            break
        time.sleep(0.01)
    status = engine.status()
    assert status["ready"] is False
    assert status["errorKind"] == "low_disk"
    assert "insufficient disk space" in status["error"]


def test_hf_cache_dir_env_resolution(monkeypatch):
    import layaguard.engine as eng

    monkeypatch.setenv("HF_HUB_CACHE", "/data/hub")
    monkeypatch.delenv("HF_HOME", raising=False)
    assert eng._hf_cache_dir() == "/data/hub"
    monkeypatch.delenv("HF_HUB_CACHE")
    monkeypatch.setenv("HF_HOME", "/data/hf")
    assert eng._hf_cache_dir() == "/data/hf/hub"


def test_state_truncated_to_max_chars():
    engine, agent = make_engine({}, maxChars=50)
    verdict = engine.moderate("x" * 500)
    assert len(agent.calls[0]["state"]["post"]) == 50
    assert verdict["truncated"] is True


def test_checkpoint_change_unloads_and_reloads():
    engine, _ = make_engine({}, checkpoint="english")
    assert engine.ready() is True
    engine.configure({"checkpoint": "multilingual"})
    # configure() dropped the old agent and started a reload
    for _ in range(200):
        if engine.ready():
            break
        time.sleep(0.01)
    assert engine.ready() is True


def test_blank_input_returns_none():
    engine, agent = make_engine()
    assert engine.moderate("   ") is None
    assert agent.calls == []


def test_decide_validates_input():
    engine, _ = make_engine()
    assert "error" in engine.decide({}, {})
    result = engine.decide({"post": "hi"}, {"q": {"type": "noul", "instructions": "?"}})
    assert result is not None and "answers" in result


def test_question_schemas_cover_expected_fields():
    assert set(MODERATION_QUESTIONS) == {
        "spam",
        "toxic",
        "harassment",
        "threat",
        "severity",
    }
