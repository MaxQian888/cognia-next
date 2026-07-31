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
