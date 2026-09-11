import unittest
from cognia.types import define_subscription_provider
from cognia import VALID_CAPABILITIES, MANIFEST_CONTRIBUTIONS, PLUGIN_POINT_CONTRACTS


class SubscriptionProviderTest(unittest.TestCase):
    def test_declarative_subscription_provider(self):
        definition = {"id": "example", "name": "Example", "baseUrl": "https://example.com/v1", "protocol": "openai", "models": ["model"]}
        self.assertIs(define_subscription_provider(definition), definition)
        self.assertIn("subscription-provider", VALID_CAPABILITIES)
        point = next(point for point in PLUGIN_POINT_CONTRACTS if point["id"] == "subscription.provider")
        self.assertNotIn("permission", point)
        self.assertTrue(any(entry["field"] == "subscriptionProviders" and entry["execution"] == "host" for entry in MANIFEST_CONTRIBUTIONS))
