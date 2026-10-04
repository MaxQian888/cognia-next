import asyncio
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("desktop_server", pathlib.Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class AuthenticationTests(unittest.TestCase):
    def request(self, kind, headers, extensions=None):
        events = []

        async def application(scope, receive, send):
            events.append({"allowed": True})

        async def send(value):
            events.append(value)

        asyncio.run(server.TokenAuth(application, "a" * 64)(
            {"type": kind, "headers": headers, "extensions": extensions or {}}, None, send))
        return events

    def test_missing_wrong_duplicate_and_browser_origin_are_denied(self):
        for headers in [[], [(b"x-cognia-sandbox-token", b"wrong")],
                        [(b"x-cognia-sandbox-token", b"a" * 64)] * 2,
                        [(b"x-cognia-sandbox-token", b"a" * 64), (b"origin", b"http://localhost")]]:
            self.assertEqual(self.request("http", headers)[0]["status"], 401)
            self.assertEqual(self.request("websocket", headers, {"websocket.http.response": {}})[0]["status"], 401)

    def test_authenticated_native_http_and_websocket_reach_upstream(self):
        for kind in ["http", "websocket"]:
            self.assertEqual(self.request(kind, [(b"x-cognia-sandbox-token", b"a" * 64)]), [{"allowed": True}])

    def test_websocket_without_denial_extension_closes_before_accept(self):
        self.assertEqual(self.request("websocket", [])[0], {"type": "websocket.close", "code": 1008})


if __name__ == "__main__":
    unittest.main()
