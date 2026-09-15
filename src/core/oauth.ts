/**
 * OAuth 授权码模式：换 access_token / 临时密钥，以及过期自动刷新。
 *
 * 两条不能退让的安全约束：
 * 1. 始终校验 TLS 证书。关掉校验会让中间人拿到 access_token。
 * 2. loopback 只绑 127.0.0.1（见 browserFlow），不绑全部网卡。
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { tokenBaseOf } from "./config.js";
import { t } from "./i18n.js";
import { CONFIG_DIR, credentialPath } from "./paths.js";
import { type CredentialFile, readCredentialFile } from "./credentials.js";

// 兑换服务基址按站点取（见 tokenBaseOf）：自建后端两站各自独立部署、
// 各持对应站点的 OAuth 应用密钥；公共后端两站共用一个地址、由 Site 参数区分。

/**
 * 凭证是 refreshToken → accessToken → 临时密钥 三级链条，下面两个阈值决定
 * 「提前多久换」。**两者要明显错开**，因为它们对应的续期代价不同：
 *
 *   临时密钥快过期  → 用 accessToken 调 get_temp_cred，一次请求，链路短
 *   accessToken 也快过期 → 得先用 refreshToken 换 accessToken，多一跳、多一个失效点
 *
 * 若两个阈值取同一个值，而上游给这两者的有效期又恰好相同（当前都是 2 小时、
 * 到期时刻相差不到 1 秒），两个判断就会在同一时刻命中，于是每次续期都被迫走完整
 * 链条——最长的那条路成了唯一的路，任何一跳出问题都直接失败，没有退路。
 *
 * 错开之后，临时密钥先到阈值、此时 accessToken 还宽裕，多数续期只需短链路；
 * 只有长时间未使用（错过这个窗口）才需要动 refreshToken。
 */
const CRED_REFRESH_SAFE_DUR = 60 * 20;

/** accessToken 剩余不足这个秒数才用 refreshToken 换新的——刻意比上面小，见上方说明 */
const ACCESS_REFRESH_SAFE_DUR = 60 * 5;

/** 授权回调带回来的 token 信息 */
export interface OAuthToken {
  openId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  state: string;
  site: string;
}

/** 兑换到的临时密钥 */
export interface TempCredential {
  secretId: string;
  secretKey: string;
  token: string;
  expiresAt: number;
}

async function postJson(
  site: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await fetch(tokenBaseOf(site) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ TraceId: randomUUID(), ...body }),
  });
  const data = (await resp.json()) as Record<string, unknown>;
  // 后端以 body 里有无 Error 字段表达失败（HTTP 状态码之外的业务错误）
  if (data["Error"]) {
    throw new Error(`${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

/** 用 refreshToken 换新的 access_token */
export async function refreshUserToken(
  refreshToken: string,
  openId: string,
  site: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const resp = await postJson(site, "/refresh_user_token", {
    RefreshToken: refreshToken,
    OpenId: openId,
    Site: site,
  });
  return { accessToken: String(resp["AccessToken"]), expiresAt: Number(resp["ExpiresAt"]) };
}

/** 用 access_token 换临时密钥三件套 */
export async function getTempCred(accessToken: string, site: string): Promise<TempCredential> {
  const resp = await postJson(site, "/get_temp_cred", { AccessToken: accessToken, Site: site });
  return {
    secretId: String(resp["SecretId"]),
    secretKey: String(resp["SecretKey"]),
    token: String(resp["Token"]),
    expiresAt: Number(resp["ExpiresAt"]),
  };
}

/** 落盘凭证文件（0600） */
export function saveCredential(
  token: OAuthToken,
  cred: TempCredential,
  profile: string,
  site: string,
  identity?: CredentialFile["identity"],
): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const path = credentialPath(profile, site);
  // 账号身份跟账号绑定、不随密钥轮换而变，所以续期时要保留既有值——
  // 这个函数会被 maybeRefreshCredential 反复调用，整份重写会把它冲掉，
  // 于是每次续期后都要多查一次 cam
  const keptIdentity = identity ?? readCredentialFile(profile, site).identity;
  const payload: CredentialFile = {
    type: "oauth",
    secretId: cred.secretId,
    secretKey: cred.secretKey,
    token: cred.token,
    expiresAt: cred.expiresAt,
    oauth: {
      openId: token.openId,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      refreshToken: token.refreshToken,
      site: token.site,
    },
    ...(keptIdentity ? { identity: keptIdentity } : {}),
  };
  fs.writeFileSync(path, `${JSON.stringify(payload, null, 4)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    // 某些文件系统不支持 chmod
  }
}

/**
 * 命令执行前调用：临时密钥快过期就自动续。只处理 type=oauth，
 * 永久密钥（static）无需刷新。
 *
 * 失败不中断命令——手上那份密钥往往还有几分钟有效期，够跑完这条命令；直接 throw
 * 会把「续期没成功」变成「命令跑不了」，反而更糟。
 *
 * 但失败必须**显式报出来**。续期是背景动作，用户没主动触发它，一旦悄悄失败，
 * 后续命令会拿着过期凭证去调云 API，最终报出的是 AuthFailure.TokenFailure 之类的
 * 下游错误——那个错误看起来与登录无关，用户很难联想到「其实是续期没成功」。
 * 所以这里要指名根因、给出下一步动作，而不是留一行不起眼的日志。
 */
export async function maybeRefreshCredential(profile: string, site: string): Promise<void> {
  const path = credentialPath(profile, site);
  let cred: CredentialFile;
  try {
    cred = JSON.parse(fs.readFileSync(path, "utf8")) as CredentialFile;
  } catch {
    return;
  }
  if (cred.type !== "oauth" || !cred.oauth) {
    return;
  }

  const now = Date.now() / 1000;
  if ((cred.expiresAt ?? 0) - now > CRED_REFRESH_SAFE_DUR) {
    return;
  }

  try {
    const info = cred.oauth;
    if (info.expiresAt - now < ACCESS_REFRESH_SAFE_DUR) {
      const fresh = await refreshUserToken(info.refreshToken, info.openId, info.site);
      info.accessToken = fresh.accessToken;
      info.expiresAt = fresh.expiresAt;
    }

    const newCred = await getTempCred(info.accessToken, info.site);
    saveCredential({ ...info, state: "" }, newCred, profile, site);
  } catch (err) {
    // 走 stderr：--json 模式下 stdout 必须是纯 JSON，混一行人话会让解析失败
    const reason = err instanceof Error ? err.message : String(err);
    const expired = (cred.expiresAt ?? 0) - now <= 0;
    console.error(t(expired ? "cred.refreshFailedExpired" : "cred.refreshFailed", { reason }));
  }
}
