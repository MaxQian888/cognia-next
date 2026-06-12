"""Tests for cognia.a2ui."""

from __future__ import annotations

import pytest

from cognia import A2UIComponent, A2UITemplate, define_component, define_template


def test_define_component_minimal_and_full():
    minimal = define_component("Gauge")
    assert minimal == A2UIComponent(name="Gauge")
    assert minimal.to_dict() == {"name": "Gauge", "schema": {}}

    full = define_component(
        "Gauge",
        schema={"type": "object"},
        description="A dial",
        category="charts",
    )
    assert full.to_dict() == {
        "name": "Gauge",
        "schema": {"type": "object"},
        "description": "A dial",
        "category": "charts",
    }


def test_define_component_requires_name():
    with pytest.raises(ValueError, match="component name"):
        define_component("  ")


def test_define_template():
    template = define_template("card", "Card", template={"kind": "card"})
    assert template == A2UITemplate(id="card", name="Card", template={"kind": "card"})
    assert template.to_dict() == {
        "id": "card",
        "name": "Card",
        "template": {"kind": "card"},
    }


@pytest.mark.parametrize("bad", ["", " "])
def test_define_template_requires_id_and_name(bad):
    with pytest.raises(ValueError, match="id"):
        define_template(bad, "ok")
    with pytest.raises(ValueError, match="name"):
        define_template("ok", bad)
