"""Tests for cognia.capability_contract."""

from __future__ import annotations

import pytest

from cognia import (
    CANONICAL_CAPABILITY_CONTRACTS,
    CapabilityContract,
    define_capability_contract,
    validate_capabilities,
)
from cognia.capability_contract import capability_contract_from_dict


def _contracts():
    return [
        define_capability_contract("tools", "supported", manifest_fields=["tools"]),
        define_capability_contract("themes", "partial"),
        define_capability_contract("processors", "experimental"),
        define_capability_contract("legacy", "blocked"),
    ]


def test_define_capability_contract_to_dict_camelcase():
    contract = define_capability_contract(
        "tools",
        "supported",
        manifest_fields=["tools"],
        runtime_binding="context.agent.registerTool",
        host_bindings=["lib/plugin/core/registry.ts"],
        typescript_sdk=["plugin-sdk/typescript/src/index.ts"],
        python_sdk=["plugin-sdk/python/src/cognia/plugin.py"],
        builtin_contribution_paths=["plugins/web-tools/src/index.ts"],
        docs="docs/x.mdx#capabilities",
        required_tests=["lib/plugin/core/manager.test.ts"],
    )
    out = contract.to_dict()
    assert out["manifestFields"] == ["tools"]
    assert out["typescriptSdk"] == ["plugin-sdk/typescript/src/index.ts"]
    assert out["pythonSdk"] == ["plugin-sdk/python/src/cognia/plugin.py"]
    assert out["builtinContributionPaths"] == ["plugins/web-tools/src/index.ts"]
    assert out["requiredTests"] == ["lib/plugin/core/manager.test.ts"]


def test_define_capability_contract_rejects_bad_inputs():
    with pytest.raises(ValueError, match="id"):
        define_capability_contract("", "supported")
    with pytest.raises(ValueError, match="support level"):
        define_capability_contract("x", "totally-made-up")


def test_validate_supported_is_clean():
    outcome = validate_capabilities(["tools"], _contracts())
    assert outcome.allowed is True
    assert outcome.diagnostics == []


def test_generated_canonical_contract_is_the_default():
    assert any(contract.id == "context-panel" for contract in CANONICAL_CAPABILITY_CONTRACTS)
    assert validate_capabilities(["context-panel"]).allowed is True
    assert validate_capabilities(["not-canonical"]).allowed is False


def test_validate_unknown_is_error():
    outcome = validate_capabilities(["nope"], _contracts())
    assert outcome.allowed is False
    assert outcome.diagnostics[0].code == "plugin.capability.unknown"
    assert outcome.diagnostics[0].severity == "error"


def test_validate_partial_and_experimental_are_warnings():
    outcome = validate_capabilities(["themes", "processors"], _contracts())
    assert outcome.allowed is True
    codes = {d.code for d in outcome.diagnostics}
    assert codes == {"plugin.capability.partial", "plugin.capability.experimental"}
    assert all(d.severity == "warning" for d in outcome.diagnostics)


def test_validate_blocked_depends_on_governance_mode():
    warn = validate_capabilities(["legacy"], _contracts())
    assert warn.allowed is True
    assert warn.diagnostics[0].severity == "warning"

    block = validate_capabilities(["legacy"], _contracts(), governance_mode="block")
    assert block.allowed is False
    assert block.diagnostics[0].severity == "error"
    assert block.diagnostics[0].code == "plugin.capability.blocked"


def test_capability_contract_from_dict_roundtrip():
    src = define_capability_contract(
        "a2ui",
        "supported",
        manifest_fields=["a2uiComponents"],
        host_bindings=["lib/plugin/bridge/a2ui-bridge.ts"],
        docs="docs/x.mdx#a2ui",
    )
    restored = capability_contract_from_dict(src.to_dict())
    assert isinstance(restored, CapabilityContract)
    assert restored.to_dict() == src.to_dict()
