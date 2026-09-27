import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentQuotaCard } from "./Quota";

test("offline quotas remain historical and successful subscription lookup does not imply task access", () => {
  const html = renderToStaticMarkup(
    <AgentQuotaCard
      online={false}
      agent={{
        kind: "codex",
        installed: true,
        executionAvailable: false,
        authMessage: "API 调用未获允许",
        quota: {
          status: "available",
          checkedAt: 1,
          windows: [{ id: "week", label: "每周", usedPercent: 7 }],
        },
      }}
    />,
  );
  expect(html).toContain("上次剩余");
  expect(html).toContain("93");
  expect(html).toContain("设备离线");
  expect(html).toContain("运行受限");
  expect(html).toContain("API 调用未获允许");
  expect(html).not.toContain("需要登录");
});
test("expired samples and missing windows are not presented as current or unlimited", () => {
  const html = renderToStaticMarkup(
    <AgentQuotaCard
      online
      agent={{
        kind: "claude",
        installed: true,
        quota: {
          status: "available",
          checkedAt: 1,
          staleAt: 2,
          windows: [{ id: "five", label: "5 小时", usedPercent: 100 }],
        },
      }}
    />,
  );
  expect(html).toContain("上次剩余");
  expect(html).toContain("已过期");
  const empty = renderToStaticMarkup(
    <AgentQuotaCard
      online
      agent={{
        kind: "codex",
        installed: true,
        quota: { status: "unavailable", checkedAt: 1, windows: [], message: "额度未知" },
      }}
    />,
  );
  expect(empty).toContain("额度未知");
  expect(empty).not.toContain("100%");
});
