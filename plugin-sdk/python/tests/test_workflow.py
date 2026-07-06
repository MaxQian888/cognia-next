"""Tests for cognia.workflow manifest mirrors."""

from __future__ import annotations

import pytest

from cognia import (
    define_configuration,
    define_scheduled_task,
    define_workflow_template,
)


# -- workflow-template ------------------------------------------------------


def test_workflow_template_minimal_and_full():
    t = define_workflow_template(
        "wt", "WT", "d", "automation", [{"id": "n1"}], [{"from": "n1", "to": "n2"}]
    )
    d = t.to_dict()
    assert d["category"] == "automation"
    assert d["nodes"] == [{"id": "n1"}] and d["edges"] == [{"from": "n1", "to": "n2"}]
    assert "icon" not in d
    full = define_workflow_template(
        "wt",
        "WT",
        "d",
        "automation",
        [{"id": "n1"}],
        [],
        icon="Workflow",
        complexity="advanced",
        settings={"concurrency": 1},
        requires={"mcpServerPresetIds": ["p:m"]},
    )
    fd = full.to_dict()
    assert fd["icon"] == "Workflow" and fd["complexity"] == "advanced"
    assert fd["settings"] == {"concurrency": 1}
    assert fd["requires"] == {"mcpServerPresetIds": ["p:m"]}


def test_workflow_template_rejects_bad_complexity():
    with pytest.raises(ValueError, match="complexity"):
        define_workflow_template("wt", "WT", "d", "cat", [], [], complexity="wizard")


def test_workflow_template_requires_core():
    with pytest.raises(ValueError):
        define_workflow_template("", "n", "d", "c", [], [])


# -- scheduled-task ---------------------------------------------------------


def test_scheduled_task_minimal_and_full():
    t = define_scheduled_task("digest", "runDigest", {"kind": "cron", "cron": "0 9 * * *"})
    d = t.to_dict()
    assert d == {
        "name": "digest",
        "handler": "runDigest",
        "trigger": {"kind": "cron", "cron": "0 9 * * *"},
    }
    full = define_scheduled_task(
        "digest",
        "runDigest",
        {"kind": "interval", "seconds": 60},
        description="Daily digest",
        default_enabled=True,
        retry={"maxAttempts": 3, "delaySeconds": 10},
        timeout=120,
        tags=["digest"],
    )
    fd = full.to_dict()
    assert fd["description"] == "Daily digest" and fd["defaultEnabled"] is True
    assert fd["retry"] == {"maxAttempts": 3, "delaySeconds": 10}
    assert fd["timeout"] == 120 and fd["tags"] == ["digest"]


def test_scheduled_task_validations():
    with pytest.raises(ValueError, match="handler"):
        define_scheduled_task("n", "", {"kind": "cron"})
    with pytest.raises(ValueError, match="trigger"):
        define_scheduled_task("n", "h", {})


# -- configuration ----------------------------------------------------------


def test_configuration_minimal_and_full():
    c = define_configuration({"greeting": {"type": "string"}})
    assert c.to_dict() == {"type": "object", "properties": {"greeting": {"type": "string"}}}
    full = define_configuration(
        {"greeting": {"type": "string"}, "count": {"type": "number"}},
        required=["greeting"],
    )
    assert full.to_dict()["required"] == ["greeting"]


def test_configuration_rejects_unknown_required():
    with pytest.raises(ValueError, match="not present"):
        define_configuration({"a": {"type": "string"}}, required=["b"])
