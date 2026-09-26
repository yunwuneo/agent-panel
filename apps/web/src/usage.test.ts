import { describe, expect, it } from "bun:test";
import { totalTokens, uncachedInput } from "./usage";

describe("canonical token accounting", () => {
  it("counts cached input once across totals and the composition chart", () => {
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10 };
    expect(totalTokens(usage)).toBe(120);
    expect(uncachedInput(usage)).toBe(50);
    expect(
      uncachedInput(usage) + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    ).toBe(totalTokens(usage));
  });
  it("uses available canonical counts without inventing unknown input", () => {
    expect(totalTokens({ outputTokens: 12 })).toBe(12);
    expect(totalTokens({})).toBe(0);
  });
});
