import { toReportableRoute } from "./reportable-route"

it.each([
  ["/chat?token=secret#private", "/chat"],
  ["/settings/appearance/deeper", "/settings/appearance"],
  ["/chat/123456789", "other"],
  ["/", "/"],
  [null, "other"],
])("normalizes reportable route %s", (input, expected) => {
  expect(toReportableRoute(input)).toBe(expected)
})
