/**
 * 管控面云 API 客户端（TC3 签名走官方 SDK）。
 *
 * 只用 SDK 的通用 request 入口按 action 名分发，不为 33 个 Action 各写一个包装
 * ——参数结构由调用方按 api.json 拼，新增 Action 无需改这里（这也是 `thcli api
 * <action>` 兜底通道的实现基础）。
 */
import * as tokenhubSdk from "tencentcloud-sdk-nodejs-tokenhub";

import { apiEndpointOf, envConfigOf } from "./config.js";
import { type GlobalArgs, parseGlobalArgs, resolveEnv } from "./credentials.js";
import { agentForEnv } from "./http-agent.js";
import { resolveIdentity } from "./identity.js";
import { t } from "./i18n.js";
import { maybeRefreshCredential } from "./oauth.js";
import { logControlPlaneCall } from "./telemetry.js";

/** tokenhub 云 API 版本 */
export const TOKENHUB_VERSION = "2026-03-22";

/** 测试网关要求携带的账号头，见 config.ts 的 EnvConfig.requiresUserId */
const USER_ID_HEADER = "X-Qcloud-User-Id";

/** SDK 客户端上真正发请求的方法，官方类型未导出，此处按实际形态声明 */
interface RawClient {
  request(action: string, req: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** 带上下文的客户端，命令层用它发请求 */
export interface Client {
  /** 调一个 Action，返回响应体（已剥掉 SDK 的外层包装） */
  call(action: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 当前生效的 profile，命令层做本地存储时要用 */
  profile: string;
  /** 当前生效的站点 */
  site: string;
  /** 当前生效的云 API 地域 */
  region: string;
}

/**
 * 构造客户端。保持同步签名（命令层 40 处调用点无需改动），凭证刷新推迟到每次
 * call 时懒执行：OAuth 临时密钥快过期就自动续，永久密钥直接跳过（no-op）。
 */
export function buildClient(args: GlobalArgs): Client {
  const initial = parseGlobalArgs(args);
  const profile = initial.profile;
  const site = initial.site;
  const env = resolveEnv();
  const endpoint = apiEndpointOf(env);
  const routeByUserId = envConfigOf(env).routeByUserId === true;

  const agent = agentForEnv(env);

  return {
    profile,
    site,
    region: initial.region,
    async call(action, params = {}) {
      // 懒刷新：临时密钥快过期才真正换，否则一次文件读的 no-op
      await maybeRefreshCredential(profile, site);
      const cred = parseGlobalArgs(args);
      if (!cred.secretId || !cred.secretKey) {
        throw new Error(t("cred.missing"));
      }

      // 只有声明需要的环境才注入账号头：正式网关从临时密钥反查账号，多带没意义；
      // 测试网关不反查，缺它则非广州地域一律 InternalError。查身份本身要发一次
      // 请求，故只在真要用时才查（首次查完即缓存进凭证文件）
      const userId = routeByUserId ? (await resolveIdentity(args)).uin : undefined;

      // 每次 call 都按最新凭证构造 SDK client（本地构造开销可忽略，网络才是大头）
      const raw = new tokenhubSdk.tokenhub.v20260322.Client({
        credential: {
          secretId: cred.secretId,
          secretKey: cred.secretKey,
          // 临时密钥才有 token；永久密钥留空
          token: cred.token,
        },
        region: cred.region,
        profile: {
          httpProfile: {
            reqTimeout: 60,
            // 未配时不传，让 SDK 用它内置的正式 endpoint
            ...(endpoint ? { endpoint } : {}),
            ...(userId ? { headers: { [USER_ID_HEADER]: userId } } : {}),
            ...(agent ? { agent } : {}),
          },
        },
      }) as unknown as RawClient;

      const start = Date.now();
      try {
        const resp = await raw.request(action, params);
        logControlPlaneCall(profile, site, {
          action,
          // 成功响应的 RequestId 在 body 顶层，便于事后向云 API 侧定位问题
          requestId: typeof resp["RequestId"] === "string" ? resp["RequestId"] : undefined,
          durationMs: Date.now() - start,
          status: "ok",
        });
        return resp;
      } catch (err) {
        logControlPlaneCall(profile, site, {
          action,
          // 失败时 RequestId 挂在 SDK 异常对象上（requestId 字段）
          requestId:
            err && typeof err === "object" && typeof (err as { requestId?: unknown }).requestId === "string"
              ? (err as { requestId: string }).requestId
              : undefined,
          durationMs: Date.now() - start,
          status: "error",
          error: (err as Error).message,
        });
        throw err;
      }
    },
  };
}
