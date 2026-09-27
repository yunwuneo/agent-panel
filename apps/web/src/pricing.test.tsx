import { expect, test } from "bun:test";
import { parsePriceDraft } from "./PricingSettings";

test("blank prices are unknown, explicit zero is valid, malformed and negative prices are rejected", () => {
  const rates = { input: "0", output: "0", cacheRead: "0", cacheWrite: "0" };
  expect(parsePriceDraft("custom", rates).input).toBe(0);
  expect(() => parsePriceDraft("custom", { ...rates, input: "" })).toThrow("请填写");
  expect(() => parsePriceDraft("custom", { ...rates, input: " " })).toThrow();
  expect(() => parsePriceDraft("custom", { ...rates, input: "abc" })).toThrow();
  expect(() => parsePriceDraft("custom", { ...rates, input: "-1" })).toThrow();
});
