"""Tests for cognia.pi_package (ADR-0210)."""

from __future__ import annotations

import pytest

from cognia import PI_PACKAGE_ENV_PREFIX, define_pi_package


def test_minimal_package_is_install_only():
    pkg = define_pi_package("latex", "LaTeX", ".")
    assert pkg.to_dict() == {"id": "latex", "name": "LaTeX", "path": "."}


def test_full_package_emits_the_manifest_shape():
    pkg = define_pi_package(
        "latex-workbench",
        "LaTeX workbench",
        "pi",
        min_pi_version="0.85.1",
        prepare_program="npm",
        prepare_args=["ci", "--ignore-scripts"],
        prepare_marker="pi/node_modules/.package-lock.json",
        prepare_timeout_ms=120000,
        extensions=["pi/extensions/latex.ts"],
        env={"TEX_ENGINE": {"config": "engine"}, "WORKSPACE": {"workspace": True}},
        tools=["latex_compile"],
        controls_session=True,
    )
    assert pkg.to_dict() == {
        "id": "latex-workbench",
        "name": "LaTeX workbench",
        "path": "pi",
        "minPiVersion": "0.85.1",
        "prepare": {
            "program": "npm",
            "args": ["ci", "--ignore-scripts"],
            "marker": "pi/node_modules/.package-lock.json",
            "timeoutMs": 120000,
        },
        "hostedSession": {
            "extensions": ["pi/extensions/latex.ts"],
            "env": [
                {"name": "TEX_ENGINE", "from": {"config": "engine"}},
                {"name": "WORKSPACE", "from": {"workspace": True}},
            ],
            "tools": ["latex_compile"],
            "controlsSession": True,
        },
    }
    assert PI_PACKAGE_ENV_PREFIX == "COGNIA_PIPKG_"


@pytest.mark.parametrize(
    "kwargs, message",
    [
        ({"id": "Bad_Id"}, "kebab-case"),
        ({"path": "../x"}, "leave the plugin"),
        ({"path": "/abs"}, "relative"),
        ({"path": "a\\b"}, "forward slashes"),
        ({"prepare_program": "sh"}, "prepare_program"),
        ({"extensions": []}, "at least one"),
        ({"extensions": ["pi/x.py"]}, "must end in"),
        ({"extensions": ["pi/x.ts"], "env": {"lower": {"value": "1"}}}, "env name"),
        ({"extensions": ["pi/x.ts"], "env": {"A": {"value": "1", "config": "k"}}}, "exactly one"),
        ({"extensions": ["pi/x.ts"], "tools": ["bash"]}, "tool"),
        ({"tools": ["x_tool"]}, "require extensions"),
    ],
)
def test_rejects_author_mistakes(kwargs, message):
    args = {"id": "latex", "name": "LaTeX", "path": "pi"}
    args.update(kwargs)
    with pytest.raises(ValueError, match=message):
        define_pi_package(args.pop("id"), args.pop("name"), args.pop("path"), **args)
