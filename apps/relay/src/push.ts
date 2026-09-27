import { readFile } from "node:fs/promises";
import { connect } from "node:http2";
import type { Envelope } from "@agentpanel/protocol";
import { importPKCS8, SignJWT } from "jose";
import webpush from "web-push";
import { ApiError, digest } from "./auth";
import type { RelayConfig } from "./config";
import type { NotificationKind } from "./hub";
import type { RecordData, Store } from "./store";

export interface PushSetting extends RecordData {
  deviceId?: string;
  sessionId?: string;
  enabled: boolean;
  approval: boolean;
  completed: boolean;
  error: boolean;
  waiting: boolean;
  preview: boolean;
}
const defaultSetting = {
  enabled: true,
  approval: true,
  completed: true,
  error: true,
  waiting: true,
  preview: false,
};
const titles = {
  approval: "需要你的审批",
  completed: "任务已完成",
  error: "任务发生错误",
  waiting: "任务等待输入",
};

export class PushService {
  private apnsJwt?: { value: string; expiresAt: number };
  constructor(
    private store: Store,
    private config: RelayConfig,
  ) {}
  status() {
    return {
      webPush: {
        enabled: !!(
          this.config.vapidPublicKey &&
          this.config.vapidPrivateKey &&
          this.config.vapidSubject
        ),
        publicKey: this.config.vapidPublicKey ?? null,
      },
      apns: {
        enabled: !!(
          this.config.apnsKeyPath &&
          this.config.apnsKeyId &&
          this.config.apnsTeamId &&
          (this.config.apnsTopic || this.config.apnsIosTopic || this.config.apnsMacosTopic)
        ),
        platforms: {
          ios: !!apnsTopicFor(this.config, "ios"),
          macos: !!apnsTopicFor(this.config, "macos"),
        },
      },
    };
  }
  async registerWeb(owner: string, subscription: webpush.PushSubscription) {
    validatePushEndpoint(subscription.endpoint);
    const id = digest(`${owner}:web:${subscription.endpoint}`);
    await this.store.put("push_subscriptions", {
      id,
      owner,
      createdAt: Date.now(),
      kind: "web",
      subscription,
    });
    return { id };
  }
  async registerAPNs(owner: string, deviceToken: string, platform: string) {
    const id = digest(`${owner}:apns:${deviceToken}`);
    await this.store.put("push_subscriptions", {
      id,
      owner,
      createdAt: Date.now(),
      kind: "apns",
      token: deviceToken,
      platform,
    });
    return { id };
  }
  async settings(owner: string) {
    const stored = await this.store.list<PushSetting>("push_settings", owner);
    if (!stored.find((s) => !s.deviceId && !s.sessionId))
      stored.unshift({ id: "global", owner, createdAt: Date.now(), ...defaultSetting });
    return stored.map(({ owner: _owner, ...s }) => s);
  }
  async updateSetting(owner: string, patch: Partial<PushSetting>) {
    const key = digest(`${owner}:${patch.deviceId ?? ""}:${patch.sessionId ?? ""}`);
    const previous = await this.store.get<PushSetting>("push_settings", key, owner);
    const row = {
      ...defaultSetting,
      ...previous,
      ...patch,
      id: key,
      owner,
      createdAt: previous?.createdAt ?? Date.now(),
    } as PushSetting;
    await this.store.put("push_settings", row);
    const { owner: _owner, ...setting } = row;
    return setting;
  }
  async notify(owner: string, kind: NotificationKind, event: Envelope) {
    const settings = await this.store.list<PushSetting>("push_settings", owner);
    const matched = settings
      .filter(
        (s) =>
          (!s.deviceId || s.deviceId === event.deviceId) &&
          (!s.sessionId || s.sessionId === event.sessionId),
      )
      .sort(
        (a, b) =>
          Number(!!a.deviceId) +
          2 * Number(!!a.sessionId) -
          Number(!!b.deviceId) -
          2 * Number(!!b.sessionId),
      );
    const preference = Object.assign({}, defaultSetting, ...matched);
    if (!preference.enabled || !preference[kind]) return;
    const question = event.type === "approval.request" && !!event.payload.questions?.length;
    const title = question ? "需要你回答问题" : titles[kind];
    const body =
      preference.preview && question
        ? event.payload.questions![0]!.question.slice(0, 160)
        : preference.preview && event.type === "approval.request"
          ? `工具：${event.payload.toolName}`
          : preference.preview && event.type === "session.event" && event.payload.error
            ? event.payload.error.message.slice(0, 160)
            : "打开 AgentPanel 查看详情";
    const metadata = {
      type: kind,
      sessionId: event.sessionId,
      deviceId: event.deviceId,
      approvalId: event.type === "approval.request" ? event.payload.id : undefined,
    };
    const subscriptions = await this.store.list("push_subscriptions", owner);
    await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        try {
          if (subscription.kind === "web" && this.status().webPush.enabled) {
            const data = subscription.subscription as webpush.PushSubscription;
            validatePushEndpoint(data.endpoint);
            await webpush.sendNotification(
              data,
              JSON.stringify({
                title,
                question,
                body,
                ...metadata,
                url: event.sessionId ? `/?session=${encodeURIComponent(event.sessionId)}` : "/",
              }),
              {
                TTL: 300,
                timeout: 10_000,
                vapidDetails: {
                  subject: this.config.vapidSubject!,
                  publicKey: this.config.vapidPublicKey!,
                  privateKey: this.config.vapidPrivateKey!,
                },
              },
            );
          } else if (subscription.kind === "apns" && this.status().apns.enabled) {
            const topic = apnsTopicFor(this.config, subscription.platform as string);
            if (!topic) return;
            await this.sendAPNs(subscription.token as string, topic, {
              aps: {
                alert: { title, body },
                sound: "default",
                // Questions need the app to answer; allow/deny notification actions do not apply.
                category:
                  kind === "approval" && !question ? "AGENTPANEL_APPROVAL" : "AGENTPANEL_SESSION",
                "thread-id": event.sessionId ?? "agentpanel",
              },
              ...metadata,
            });
          } else return;
          await this.store.put("push_subscriptions", {
            ...subscription,
            lastSuccessAt: Date.now(),
            lastError: undefined,
          });
        } catch (error) {
          const statusCode = Number((error as { statusCode?: number }).statusCode);
          if ([404, 410].includes(statusCode))
            await this.store.remove("push_subscriptions", subscription.id);
          else
            await this.store.put("push_subscriptions", {
              ...subscription,
              lastFailureAt: Date.now(),
              lastError: statusCode || "delivery_failed",
            });
        }
      }),
    );
  }
  private async sendAPNs(deviceToken: string, topic: string, payload: unknown): Promise<void> {
    if (!this.apnsJwt || this.apnsJwt.expiresAt <= Date.now()) {
      const key = await importPKCS8(await readFile(this.config.apnsKeyPath!, "utf8"), "ES256");
      const value = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: this.config.apnsKeyId! })
        .setIssuer(this.config.apnsTeamId!)
        .setIssuedAt()
        .sign(key);
      this.apnsJwt = { value, expiresAt: Date.now() + 50 * 60_000 };
    }
    await new Promise<void>((resolve, reject) => {
      const client = connect(
        this.config.apnsProduction
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com",
      );
      const finish = (error?: Error) => {
        client.close();
        if (error) reject(error);
        else resolve();
      };
      client.once("error", finish);
      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.apnsJwt!.value}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 300),
      });
      let status = 0;
      request.setTimeout(10_000, () => {
        request.close();
        finish(new Error("APNs request timed out"));
      });
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", () => {});
      request.once("error", finish);
      request.once("end", () => {
        if (status === 200) finish();
        else finish(Object.assign(new Error("APNs delivery failed"), { statusCode: status }));
      });
      request.end(JSON.stringify(payload));
    });
  }
}

/** A push subscription is a fetch destination: only established browser push hosts are accepted. */
export function validatePushEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError(400, "INVALID_PUSH_ENDPOINT", "推送地址无效");
  }
  const hosts = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
    "wns.windows.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))
  )
    throw new ApiError(400, "INVALID_PUSH_ENDPOINT", "不支持此推送服务地址");
}

/** A device token is bound to its app's topic; iOS and macOS targets may use different bundle IDs. */
export function apnsTopicFor(config: RelayConfig, platform: string): string | undefined {
  if (platform === "ios") return config.apnsIosTopic ?? config.apnsTopic;
  if (platform === "macos") return config.apnsMacosTopic ?? config.apnsTopic;
  return undefined;
}
