"""Engine behavior, driven by a stubbed agent factory — no torch, no HF download."""

from __future__ import annotations

import threading
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


def test_moderate_is_counter_free():
    # The laya_moderate_check tool calls moderate() too; a flagged verdict
    # there must not look like a dropped (or would-be-dropped) message.
    engine, _ = make_engine({"spam": 0.99})
    assert engine.moderate("BUY NOW")["block"] is True
    status = engine.status()
    assert status["blocks"] == 0
    assert status["wouldBlock"] == 0
    assert status["checks"] == 1


def test_record_inbound_splits_blocks_and_would_blocks():
    engine, _ = make_engine({"spam": 0.99})
    verdict = engine.moderate("BUY NOW")
    engine.record_inbound(verdict, "observe")
    assert engine.status()["wouldBlock"] == 1
    assert engine.status()["blocks"] == 0
    engine.record_inbound(verdict, "enforce")
    assert engine.status()["blocks"] == 1
    assert engine.status()["wouldBlock"] == 1
    engine.record_inbound({"block": False}, "enforce")
    engine.record_inbound(None, "enforce")
    assert engine.status()["blocks"] == 1


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

    monkeypatch.setattr(eng, "_model_snapshot_present", lambda subfolders: False)
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
    empty = engine.decide({}, {})
    assert empty["ok"] is False
    assert empty["error"]["kind"] == "invalid_request"
    result = engine.decide({"post": "hi"}, {"q": {"type": "noul", "instructions": "?"}})
    assert result["ok"] is True
    assert "answers" in result


@pytest.mark.parametrize(
    "questions, fragment",
    [
        ({}, "non-empty"),
        ({"q": "noul"}, "must be an object"),
        ({"q": {"type": "maybe", "instructions": "?"}}, "unknown type"),
        ({"q": {"type": "noul", "instructions": "  "}}, "instructions"),
        ({"q": {"type": "choice", "instructions": "?", "criteria": {"a": "x"}}}, "2-255"),
        ({"q": {"type": "score", "instructions": "?", "criteria": ["only"]}}, "2 criteria"),
        ({"q": {"type": "noul", "instructions": "?", "criteria": {"maybe": "x"}}}, "true"),
    ],
)
def test_decide_rejects_malformed_questions(questions, fragment):
    engine, agent = make_engine()
    result = engine.decide({"post": "hi"}, questions)
    assert result["ok"] is False
    assert result["error"]["kind"] == "invalid_question"
    assert fragment in result["error"]["message"]
    assert agent.calls == []  # never reaches the forward pass


def test_decide_not_ready_reports_status():
    engine = GuardEngine(agent_factory=lambda spec: threading.Event().wait())
    out = engine.decide({"post": "hi"}, {"q": {"type": "noul", "instructions": "?"}})
    assert out["ok"] is False
    assert out["error"]["kind"] == "not_ready"
    assert out["status"]["loading"] is True
    engine.shutdown()


def test_decide_predict_failure_is_an_envelope():
    class Exploding(FakeAgent):
        def predict(self, state, questions):
            raise ValueError("question 'q' options exceed head_max_len=192")

    engine, _ = make_engine(agent=Exploding({}))
    out = engine.decide({"post": "hi"}, {"q": {"type": "noul", "instructions": "?"}})
    assert out["ok"] is False
    assert out["error"]["kind"] == "predict_failed"
    assert "head_max_len" in out["error"]["message"]


def test_decide_rejects_bad_state_trim():
    engine, _ = make_engine()
    out = engine.decide({"post": "hi"}, {"q": {"type": "noul", "instructions": "?"}}, state_trim=[""])
    assert out["ok"] is False
    assert out["error"]["kind"] == "invalid_request"


# ---------------------------------------------------------------------------
# loading: preload, generations, back-off, lock split
# ---------------------------------------------------------------------------


def wait_until(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


def test_router_spec_preloads_before_ready(monkeypatch, tmp_path):
    """checkpoint=auto must build both checkpoints on the loader thread —
    laya.Router is lazy and would otherwise download inside the first predict."""
    import layaguard.engine as eng

    calls = []

    class FakeLayaRouter:
        def __init__(self, max_loaded):
            calls.append(("init", max_loaded))
            self.loaded = []

        def preload(self, names):
            calls.append(("preload", list(names)))
            self.loaded = list(names)
            return self

    fake_laya = type("FakeLaya", (), {"Router": FakeLayaRouter})
    monkeypatch.setattr(eng, "_import_laya", lambda: fake_laya)
    monkeypatch.setattr(eng, "_model_snapshot_present", lambda subfolders: True)
    engine = GuardEngine()
    engine.request_load()
    assert wait_until(engine.ready)
    assert calls == [("init", 2), ("preload", ["english", "multilingual"])]
    assert engine.status()["loadedCheckpoints"] == ["english", "multilingual"]


def test_single_checkpoint_spec_uses_laya_load(monkeypatch):
    import layaguard.engine as eng

    seen = {}

    def fake_load(model_id, **kwargs):
        seen["model_id"] = model_id
        seen["kwargs"] = kwargs
        return FakeAgent({})

    monkeypatch.setattr(eng, "_import_laya", lambda: type("FakeLaya", (), {"load": staticmethod(fake_load)}))
    monkeypatch.setattr(eng, "_model_snapshot_present", lambda subfolders: True)
    engine = GuardEngine()
    engine.configure({"checkpoint": "multilingual"})
    assert wait_until(engine.ready)
    assert seen == {"model_id": "convaiinnovations/laya", "kwargs": {"subfolder": "multilingual"}}


def test_status_not_blocked_by_inference():
    """A slow forward pass holds only the inference lock — status/configure
    must answer immediately (they used to share one lock with predict)."""
    entered = threading.Event()
    release = threading.Event()

    class Slow(FakeAgent):
        def predict(self, state, questions):
            entered.set()
            release.wait(2)
            return super().predict(state, questions)

    engine, _ = make_engine(agent=Slow({}))
    worker = threading.Thread(target=engine.moderate, args=("hello",))
    worker.start()
    assert entered.wait(1)
    started = time.time()
    engine.status()
    engine.configure({"inboundThreshold": 0.8})
    assert time.time() - started < 0.2
    release.set()
    worker.join(2)


def test_checkpoint_change_mid_load_discards_stale_result():
    """configure() during a load must not let the old load publish a model
    for the checkpoint the user just switched away from."""
    gate = threading.Event()
    built = []

    def factory(spec):
        built.append(spec.get("subfolder"))
        if len(built) == 1:
            gate.wait(2)  # first (english) load is slow
        return FakeAgent({"name": spec.get("subfolder")})

    engine = GuardEngine(agent_factory=factory)
    engine.configure({"checkpoint": "english"})
    assert wait_until(lambda: len(built) == 1)
    engine.configure({"checkpoint": "multilingual"})
    assert engine.ready() is False  # the switch never double-starts a load
    gate.set()
    assert wait_until(engine.ready)
    assert built == [None, "multilingual"]
    assert engine.status()["checkpoint"] == "multilingual"


def test_failed_load_backs_off_until_forced_or_reconfigured():
    attempts = []

    def boom(spec):
        attempts.append(1)
        raise RuntimeError("no weights")

    now = [1000.0]
    engine = GuardEngine(agent_factory=boom, clock=lambda: now[0])
    engine.request_load()
    assert wait_until(lambda: engine.status()["errorKind"] == "load_failed")
    assert engine.moderate("anything") is None
    assert engine.moderate("anything") is None
    assert len(attempts) == 1  # callers do not re-trigger during the back-off
    assert engine.status()["retryInSeconds"] == pytest.approx(300.0)
    now[0] += 301
    engine.moderate("anything")
    assert wait_until(lambda: len(attempts) == 2 and not engine.status()["loading"])
    engine.request_load(force=True)
    assert wait_until(lambda: len(attempts) == 3)


def test_shutdown_discards_in_flight_load():
    gate = threading.Event()
    engine = GuardEngine(agent_factory=lambda spec: (gate.wait(2), FakeAgent({}))[1])
    engine.request_load()
    engine.shutdown()
    gate.set()
    time.sleep(0.05)
    assert engine.ready() is False
    assert engine.request_load() is False


def test_snapshot_presence_checks_every_subfolder(monkeypatch, tmp_path):
    import layaguard.engine as eng

    snap = tmp_path / "models--convaiinnovations--laya" / "snapshots" / "rev1"
    snap.mkdir(parents=True)
    (snap / "model.safetensors").write_bytes(b"x")
    monkeypatch.setattr(eng, "_hf_cache_dir", lambda: str(tmp_path))
    assert eng._model_snapshot_present([None]) is True
    # english cached says nothing about the ~600 MB multilingual checkpoint
    assert eng._model_snapshot_present([None, "multilingual"]) is False
    (snap / "multilingual").mkdir()
    (snap / "multilingual" / "model.safetensors").write_bytes(b"x")
    assert eng._model_snapshot_present([None, "multilingual"]) is True


# ---------------------------------------------------------------------------
# budgets: laya truncates silently — decide() measures and reports
# ---------------------------------------------------------------------------


class CharTok:
    """One token per character — enough to exercise the budget arithmetic."""

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": list(range(len(text)))}


class MeasuredAgent(FakeAgent):
    def __init__(self, scores, max_len=400, head_max_len=120):
        super().__init__(scores)
        self.tok = CharTok()
        self.cfg = {"max_len": max_len, "head_max_len": head_max_len}


def test_measure_question_mirrors_laya_head_packing():
    from layaguard.engine import measure_question

    tok = CharTok()
    q = {"type": "noul", "instructions": "x" * 20}
    m = measure_question(tok, q, max_len=200, head_max_len=120)
    # options: " false: no, ..." / " true: yes, ..." each +1 mask marker
    assert m["instructionTokens"] == len("noul question: " + "x" * 20)
    assert m["instructionTokensKept"] == m["instructionTokens"]
    assert m["optionsClipped"] == 0
    long_choice = {
        "type": "choice",
        "instructions": "pick",
        "criteria": {"a": "y" * 80, "b": "z" * 80},
    }
    clipped = measure_question(tok, long_choice, max_len=200, head_max_len=120)
    assert clipped["optionsClipped"] == 2  # each option capped at 48 tokens


def test_decide_trims_oldest_chat_messages_first():
    agent = MeasuredAgent({})
    engine, _ = make_engine(agent=agent)
    messages = [{"from": "other", "text": "m%02d " % i + "w" * 20} for i in range(20)]
    state = {"chat": {"relationship": "friend", "messages": messages}}
    out = engine.decide(
        state,
        {"q": {"type": "noul", "instructions": "tense?"}},
        state_trim=["chat", "messages"],
    )
    assert out["ok"] is True
    sent = agent.calls[0]["state"]["chat"]["messages"]
    assert out["stateTrimmed"] == 20 - len(sent)
    assert sent[-1] == messages[-1]  # the newest message always survives
    assert sent[0] != messages[0]
    assert state["chat"]["messages"] == messages  # caller's state untouched


def test_decide_reports_head_truncation():
    agent = MeasuredAgent({}, head_max_len=60)
    engine, _ = make_engine(agent=agent)
    out = engine.decide(
        {"post": "hi"},
        {"q": {"type": "noul", "instructions": "i" * 200}},
    )
    assert out["ok"] is True
    report = out["truncation"]["q"]
    assert report["instructionTokensKept"] < report["instructionTokens"]


def test_decide_pins_router_route_and_reports_it():
    class FakeRoutingRouter:
        def __init__(self):
            self.agent = MeasuredAgent({})
            self.routed = []

        def route(self, state, questions):
            return {"model": "multilingual", "reason": "non-Latin script"}

        def load(self, name):
            self.routed.append(name)
            return self.agent

    router = FakeRoutingRouter()
    router.agent.system_one = router.agent.predict
    engine, _ = make_engine(agent=router)
    out = engine.decide({"post": "你好"}, {"q": {"type": "noul", "instructions": "?"}})
    assert out["ok"] is True
    assert out["routing"]["model"] == "multilingual"
    assert router.routed == ["multilingual"]


def test_question_schemas_cover_expected_fields():
    assert set(MODERATION_QUESTIONS) == {
        "spam",
        "toxic",
        "harassment",
        "threat",
        "severity",
    }
