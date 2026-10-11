"""Glance modules from a Python plugin (ADR-0225 §6).

Three pieces: the manifest mirror (``define_glance_module``), the published-data
check (``validate_glance_data``), and the run-time path a plugin actually takes
under the host: ``@hook("onGlanceVisibilityChange")`` plus
``cognia.ctx.glance.update``, exercised here on the SDK's reference runtime.
"""

from __future__ import annotations

import pytest

import cognia
from cognia import PluginHook, define_glance_module, glance_modules_manifest, hook
from cognia import validate_glance_data
from cognia._generated_contract import API_NAMESPACE_CONTRACTS
from cognia.ctx import CALLBACK_HOST_METHODS, PYTHON_HOST_NAMESPACES
from cognia.glance import GLANCE_LIMITS


def _namespace(namespace_id):
    return next(ns for ns in API_NAMESPACE_CONTRACTS if ns["id"] == namespace_id)


# -- the contract -------------------------------------------------------------


def test_glance_is_open_to_python_for_publishing_only():
    assert "python" in _namespace("glance")["runtimes"]
    assert PYTHON_HOST_NAMESPACES["glance"] >= {"update"}
    # register / onVisibilityChange hand the host a callback.
    assert CALLBACK_HOST_METHODS["glance"] == {"register", "onVisibilityChange"}
    assert callable(cognia.ctx.glance.update)
    for name in ("register", "onVisibilityChange"):
        with pytest.raises(AttributeError) as excinfo:
            getattr(cognia.ctx.glance, name)
        assert "plugin.json" in str(excinfo.value)


def test_visibility_hook_is_a_plugin_hook():
    assert PluginHook.ON_GLANCE_VISIBILITY_CHANGE.value == "onGlanceVisibilityChange"


# -- the declaration ----------------------------------------------------------


def test_define_glance_module_emits_the_manifest_shape():
    module = define_glance_module(
        "builds",
        "Builds",
        title_key="glance.builds",
        icon="Hammer",
        sizes=["expanded", "compact", "compact"],
        platforms=["desktop"],
    )
    assert module.to_dict() == {
        "id": "builds",
        "title": "Builds",
        "titleKey": "glance.builds",
        "icon": "Hammer",
        # host order, repeats dropped
        "sizes": ["compact", "expanded"],
        "platforms": ["desktop"],
    }
    assert define_glance_module("m", "M").to_dict() == {"id": "m", "title": "M"}


@pytest.mark.parametrize(
    "kwargs, message",
    [
        ({"id": "", "title": "T"}, "glance module id"),
        ({"id": "-bad", "title": "T"}, "glance module id"),
        ({"id": "a" * 65, "title": "T"}, "glance module id"),
        ({"id": "m", "title": "  "}, "title"),
        ({"id": "m", "title": "T", "icon": "not an icon"}, "icon"),
        ({"id": "m", "title": "T", "sizes": []}, "sizes"),
        ({"id": "m", "title": "T", "sizes": ["huge"]}, "sizes"),
        ({"id": "m", "title": "T", "sizes": "compact"}, "sizes"),
        ({"id": "m", "title": "T", "platforms": ["watch"]}, "platforms"),
        ({"id": "m", "title": "T", "title_key": ""}, "title_key"),
    ],
)
def test_define_glance_module_refuses_what_the_validator_refuses(kwargs, message):
    module_id = kwargs.pop("id")
    title = kwargs.pop("title")
    with pytest.raises(ValueError, match=message):
        define_glance_module(module_id, title, **kwargs)


def test_glance_modules_manifest_checks_count_and_uniqueness():
    modules = [define_glance_module(f"m{index}", "M") for index in range(3)]
    assert [entry["id"] for entry in glance_modules_manifest(modules)] == ["m0", "m1", "m2"]
    with pytest.raises(ValueError, match="more than once"):
        glance_modules_manifest([define_glance_module("m", "A"), define_glance_module("m", "B")])
    too_many = [
        define_glance_module(f"m{index}", "M")
        for index in range(GLANCE_LIMITS["modules_per_plugin"] + 1)
    ]
    with pytest.raises(ValueError, match="at most 8"):
        glance_modules_manifest(too_many)


# -- the data -----------------------------------------------------------------

DATA = {
    "summary": "2 failing",
    "stats": [{"label": "Failing", "value": "2", "tone": "crit"}],
    "rows": [{"id": "main", "label": "main", "value": "red", "hint": "3 min", "action": "rerun"}],
    "actions": [{"id": "rerun", "label": "Run build", "icon": "Play", "command": "runBuild"}],
    "empty": "No builds yet",
}


def test_validate_glance_data_passes_valid_data_and_none():
    assert validate_glance_data(DATA) == DATA
    assert validate_glance_data({}) == {}
    assert validate_glance_data(None) is None


def test_validate_glance_data_lets_long_strings_through_for_the_host_to_cut():
    data = {"summary": "x" * 500, "rows": [{"id": "r", "label": "y" * 500}]}
    assert validate_glance_data(data) == data


@pytest.mark.parametrize(
    "data, message",
    [
        ("text", "mapping"),
        ({"title": "x"}, "unknown keys"),
        ({"stats": [{"label": "A", "value": "1"}] * 5}, "at most 4 stats"),
        ({"rows": [{"id": f"r{i}", "label": "R"} for i in range(9)]}, "at most 8 rows"),
        (
            {"actions": [{"id": f"a{i}", "label": "A", "command": "c"} for i in range(4)]},
            "at most 3 actions",
        ),
        ({"stats": [{"label": "A"}]}, "value"),
        ({"stats": [{"label": "A", "value": "1", "tone": "red"}]}, "tone"),
        ({"rows": [{"label": "R"}]}, "id"),
        ({"rows": [{"id": "r", "label": "R"}, {"id": "r", "label": "S"}]}, "more than once"),
        ({"rows": [{"id": "r", "label": "R", "action": "nope"}]}, "not published"),
        ({"actions": [{"id": "a", "label": "A"}]}, "command"),
        ({"actions": [{"id": "a", "label": "A", "command": "bad id"}]}, "command"),
        ({"rows": "row"}, "must be a list"),
        ({"summary": 3}, "summary"),
    ],
)
def test_validate_glance_data_refuses_what_the_host_would_drop(data, message):
    with pytest.raises(ValueError, match=message):
        validate_glance_data(data)


# -- the run-time path, on the reference runtime -------------------------------


def _build_glance_plugin():
    """The pattern ``plugins/cognia-python-demo/main.py`` follows."""

    @hook("onGlanceVisibilityChange")
    async def on_glance_visibility(event):
        if not isinstance(event, dict) or event.get("moduleId") != "runtime":
            return None
        if event.get("visible"):
            await cognia.ctx.glance.update(
                "runtime",
                {"summary": "Python is running", "stats": [{"label": "Calls", "value": "3"}]},
            )
        return None


def test_visibility_hook_publishes_through_ctx_glance_update(fresh_runtime):
    _build_glance_plugin()
    seen = []

    async def host(method, params):
        seen.append((method, params))
        return None

    fresh_runtime.set_host_call_handler(host)
    assert fresh_runtime.get_hooks() == [
        {"event": "onGlanceVisibilityChange", "name": "on_glance_visibility"}
    ]

    def deliver(payload):
        return fresh_runtime.dispatch(
            "call_hook",
            {"event": "onGlanceVisibilityChange", "name": "on_glance_visibility", "payload": payload},
        )

    deliver({"moduleId": "runtime", "visible": True})
    assert seen == [
        (
            "glance.update",
            {
                "args": [
                    "runtime",
                    {"summary": "Python is running", "stats": [{"label": "Calls", "value": "3"}]},
                ]
            },
        )
    ]
    # Hidden, or another module: nothing published.
    deliver({"moduleId": "runtime", "visible": False})
    deliver({"moduleId": "other", "visible": True})
    assert len(seen) == 1
