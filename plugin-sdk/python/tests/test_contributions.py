"""Python-owned module-bridge contributions.

Mirrors `_CONTRIBUTIONS` / `_dispatch_contribution` in the embedded host
(`crates/cognia-plugin-runtime/src/python/host.py`) so the authoring package
behaves identically offline. The renderer-side seam is
`lib/plugin/bridge/_shared/python-backed-proxy.ts`.
"""

import pytest

import cognia
from cognia import Runtime, reset_active_runtime, set_active_runtime


@pytest.fixture(autouse=True)
def fresh_runtime():
    runtime = set_active_runtime(Runtime())
    yield runtime
    reset_active_runtime()


def test_class_contribution_registers_public_methods(fresh_runtime):
    @cognia.contribution("tesseract")
    class Tesseract:
        def describe(self):
            return {"label": "Tesseract", "category": "local"}

        def extract(self, image, ctx=None):
            return {"text": "read:" + image}

        def _private(self):  # pragma: no cover - must never be registered
            return "nope"

    assert fresh_runtime.get_contributions() == [
        {"id": "tesseract", "methods": ["describe", "extract"]}
    ]
    assert fresh_runtime.get_info()["contribution_count"] == 1
    # The decorator returns the class untouched so the author can still use it.
    assert Tesseract().extract("a.png") == {"text": "read:a.png"}


def test_dispatch_contribution_invokes_the_method(fresh_runtime):
    @cognia.contribution("ocr")
    class Ocr:
        def describe(self):
            return {"label": "OCR"}

        def extract(self, image):
            return image.upper()

    assert fresh_runtime.dispatch_contribution("ocr", "describe") == {"label": "OCR"}
    assert fresh_runtime.dispatch_contribution("ocr", "extract", ["a.png"]) == "A.PNG"


def test_instances_are_accepted_as_well_as_classes(fresh_runtime):
    class Ready:
        def send(self, payload):
            return payload

    cognia.contribution("ready")(Ready())
    assert fresh_runtime.dispatch_contribution("ready", "send", [7]) == 7


def test_unknown_contribution_or_method_raise(fresh_runtime):
    @cognia.contribution("only")
    class Only:
        def go(self):
            return 1

    with pytest.raises(RuntimeError, match="unknown contribution"):
        fresh_runtime.dispatch_contribution("missing", "go")
    with pytest.raises(RuntimeError, match="has no method"):
        fresh_runtime.dispatch_contribution("only", "nope")


def test_invalid_registrations_are_rejected(fresh_runtime):
    with pytest.raises(ValueError, match="non-empty string"):
        cognia.contribution("")(object)

    class NoPublicMethods:
        _hidden = 1

    with pytest.raises(ValueError, match="no public methods"):
        cognia.contribution("empty")(NoPublicMethods)


def test_emit_pushes_an_inbound_frame(fresh_runtime):
    seen = []
    fresh_runtime.set_event_sink(lambda event, data, call_id: seen.append((event, data)))

    cognia.emit("mail", "inbound", {"id": "evt-1"})

    assert seen == [
        (
            "emit",
            {"contributionId": "mail", "channel": "inbound", "payload": {"id": "evt-1"}},
        )
    ]


def test_emit_defaults_payload_to_none(fresh_runtime):
    seen = []
    fresh_runtime.set_event_sink(lambda event, data, call_id: seen.append(data))

    cognia.emit("mail", "heartbeat")

    assert seen == [{"contributionId": "mail", "channel": "heartbeat", "payload": None}]


# -- per-instance contributions ---------------------------------------------


def test_class_contribution_builds_one_object_per_instance(fresh_runtime):
    built = []

    @cognia.contribution("agent")
    class Agent:
        def __init__(self):
            self.config = None
            built.append(self)

        def connect(self, config):
            self.config = config

        def current(self):
            return self.config

    assert len(built) == 1  # the default object, built at decoration time

    fresh_runtime.dispatch_contribution("agent", "connect", ["A"], instance_id="i-a")
    fresh_runtime.dispatch_contribution("agent", "connect", ["B"], instance_id="i-b")

    # Connecting B never overwrites A, and neither touches the default object.
    assert fresh_runtime.dispatch_contribution("agent", "current", instance_id="i-a") == "A"
    assert fresh_runtime.dispatch_contribution("agent", "current", instance_id="i-b") == "B"
    assert fresh_runtime.dispatch_contribution("agent", "current") is None
    assert len(built) == 3


def test_release_drops_only_that_instance(fresh_runtime):
    @cognia.contribution("agent")
    class Agent:
        def __init__(self):
            self.config = None

        def connect(self, config):
            self.config = config

        def current(self):
            return self.config

    fresh_runtime.dispatch_contribution("agent", "connect", ["A"], instance_id="i-a")
    fresh_runtime.dispatch_contribution("agent", "connect", ["B"], instance_id="i-b")

    assert fresh_runtime.dispatch_contribution("agent", "__release__", instance_id="i-a") is None

    # A fresh object answers for the released id; B is untouched.
    assert fresh_runtime.dispatch_contribution("agent", "current", instance_id="i-a") is None
    assert fresh_runtime.dispatch_contribution("agent", "current", instance_id="i-b") == "B"
    # Releasing an unknown instance is a no-op.
    fresh_runtime.release_contribution_instance("agent", "never-seen")


def test_object_contribution_serves_one_instance_at_a_time(fresh_runtime):
    class Shared:
        def ping(self):
            return "pong"

    cognia.contribution("shared")(Shared())

    assert fresh_runtime.dispatch_contribution("shared", "ping", instance_id="i-a") == "pong"
    assert fresh_runtime.dispatch_contribution("shared", "ping", instance_id="i-a") == "pong"
    with pytest.raises(RuntimeError, match="single shared object"):
        fresh_runtime.dispatch_contribution("shared", "ping", instance_id="i-b")
    # Calls without an instance id still reach the shared object.
    assert fresh_runtime.dispatch_contribution("shared", "ping") == "pong"

    fresh_runtime.dispatch_contribution("shared", "__release__", instance_id="i-a")
    assert fresh_runtime.dispatch_contribution("shared", "ping", instance_id="i-b") == "pong"


def test_release_requires_an_instance_id_and_a_known_contribution(fresh_runtime):
    @cognia.contribution("agent")
    class Agent:
        def go(self):
            return 1

    with pytest.raises(RuntimeError, match="requires an instance id"):
        fresh_runtime.dispatch_contribution("agent", "__release__")
    with pytest.raises(RuntimeError, match="unknown contribution"):
        fresh_runtime.release_contribution_instance("missing", "i-a")
    with pytest.raises(RuntimeError, match="non-empty string"):
        fresh_runtime.dispatch_contribution("agent", "go", instance_id="")


def test_redecorating_an_id_drops_its_instances(fresh_runtime):
    @cognia.contribution("agent")
    class First:
        def which(self):
            return "first"

    assert fresh_runtime.dispatch_contribution("agent", "which", instance_id="i-a") == "first"

    @cognia.contribution("agent")
    class Second:
        def which(self):
            return "second"

    assert fresh_runtime.dispatch_contribution("agent", "which", instance_id="i-a") == "second"


def test_bot_lifecycle_aliasing_reaches_an_instance(fresh_runtime, monkeypatch):
    import cognia.bot as bot

    monkeypatch.setattr(bot, "is_bot_contribution", lambda cid: cid == "bot")

    @cognia.contribution("bot")
    class Bot:
        def __init__(self):
            self.installed = False

        def on_install(self):
            self.installed = True
            return "installed"

        def state(self):
            return self.installed

    assert fresh_runtime.dispatch_contribution("bot", "onInstall", instance_id="i-a") == "installed"
    assert fresh_runtime.dispatch_contribution("bot", "state", instance_id="i-a") is True
    assert fresh_runtime.dispatch_contribution("bot", "state") is False
