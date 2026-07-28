import pytest

from cognia import Integration, define_integration


def test_define_integration_emits_schema_v4_manifest_shape():
    integration = define_integration(
        {
            "id": "example",
            "label": "Example",
            "authStrategies": [
                {
                    "id": "token",
                    "type": "api-key",
                    "label": "API key",
                    "providerId": "example-token",
                    "requestAuth": {"type": "header", "name": "x-api-key"},
                }
            ],
            "resourceKinds": ["project"],
            "eventTypes": [
                {
                    "id": "issue.created",
                    "label": "Issue created",
                    "resourceKinds": ["project"],
                }
            ],
            "actions": [
                {
                    "id": "createIssue",
                    "label": "Create issue",
                    "handler": "create_issue",
                    "risk": "write",
                    "idempotency": "required",
                    "inputSchema": {"type": "object"},
                }
            ],
            "allowedOrigins": ["https://api.example.test"],
        }
    )

    assert isinstance(integration, Integration)
    assert integration.to_dict()["actions"][0]["risk"] == "write"
    assert integration.to_dict()["allowedOrigins"] == ["https://api.example.test"]


def test_define_integration_rejects_unknown_action_risk():
    with pytest.raises(ValueError, match="action risk"):
        define_integration(
            {
                "id": "example",
                "label": "Example",
                "authStrategies": [],
                "resourceKinds": [],
                "eventTypes": [],
                "actions": [
                    {
                        "id": "bad",
                        "label": "Bad",
                        "handler": "bad",
                        "risk": "unsafe",
                        "idempotency": "none",
                        "inputSchema": {},
                    }
                ],
            }
        )


def test_define_integration_rejects_invalid_request_auth_header():
    with pytest.raises(ValueError, match="requestAuth"):
        define_integration(
            {
                "id": "example",
                "label": "Example",
                "authStrategies": [
                    {
                        "id": "token",
                        "type": "api-key",
                        "label": "API key",
                        "providerId": "example-token",
                        "requestAuth": {"type": "header", "name": "bad header"},
                    }
                ],
                "resourceKinds": [],
                "eventTypes": [],
                "actions": [],
            }
        )
