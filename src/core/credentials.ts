/**
 * 凭证与身份维度解析。
 *
 * 核心规则「整包三选一」：(secretId, secretKey, token) 三元组必须来自同一个源，
 * 按 命令行 → 环境变量 → 凭证文件 的顺序，第一层 id+key 齐全即锁定该层三件
 * （含 token，可能为空），命中即停，绝不从下层补 token。
 *
 * 为什么：逐字段回退会拼出「env 的 id/key + file 的 token」这类混合凭证
 * （永久密钥被塞进 OAuth token 位），签名必挂且极难排查。整包三选一后要么
 * 整包对、要么整包错——错误可诊断。
 *
 * 三个源里只有命令行不收 token：临时覆盖的用户手上通常是一对永久 AK/SK，
 * 不接触"会话令牌"这个概念。真要用临时密钥，走环境变量
 * （TENCENTCLOUD_TOKEN，云上工具链的既有约定）或 auth login。
 */
import fs from "node:fs";

import { DEFAULT_CLOUD_REGION, DEFAULT_ENV, DEFAULT_SITE } from "./config.js";
import { configurePath, credentialPath } from "./paths.js";
import { getSetting } from "./settings.js";

/** 命令行传入的全局选项 */
export interface GlobalArgs {
  profile?: string;
  site?: string;
  region?: string;
  secretId?: string;
  secretKey?: string;
  /** 界面语言，见 core/i18n.ts */
  lang?: string;
}

/** 凭证文件的内容结构 */
export interface CredentialFile {
  /** oauth（临时密钥，需刷新）/ static（永久密钥，不过期） */
  type?: string;
  secretId?: string;
  secretKey?: string;
  token?: string;
  region?: string;
  /** 临时密钥的到期时间（epoch 秒） */
  expiresAt?: number;
  oauth?: {
    openId: string;
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
    site: string;
  };
  /**
   * 该凭证对应的账号身份，由 cam:GetUserAppId 查得后缓存下来（见 core/identity.ts）。
   * 缓存而不是每次查：它在凭证有效期内不会变，而 monitor 等命令每次都要用 uin
   * 做查询维度，不缓存就是每条命令多一次网络往返。
   */
  identity?: {
    uin: string;
    ownerUin: string;
    appId: number;
  };
}

/** 解析后的凭证上下文 */
export interface ResolvedCredential {
  profile: string;
  site: string;
  secretId?: string;
  secretKey?: string;
  /** 有值代表临时密钥，无值代表永久密钥 */
  token?: string;
  region: string;
  /** 命中的来源，用于诊断 */
  source: "cli" | "env" | "file" | "none";
  /** 凭证文件原始内容，auth status / hello 需要读 type/expiresAt */
  raw: CredentialFile;
}

function readTrimmedFile(path: string): string | undefined {
  try {
    const value = fs.readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * profile 优先级：命令行 > 环境变量 THCLI_PROFILE > active_profile 文件 > "default"。
 * profile 只决定读哪个凭证文件，不影响命令行/环境变量两层。
 */
export function resolveProfile(args: GlobalArgs): string {
  return (
    args.profile ||
    process.env["THCLI_PROFILE"] ||
    getSetting("profile") ||
    "default"
  );
}

/** site 优先级：命令行 > 环境变量 THCLI_SITE > active_site 文件 > "cn" */
export function resolveSite(args: GlobalArgs): string {
  return (
    args.site ||
    process.env["THCLI_SITE"] ||
    getSetting("site") ||
    DEFAULT_SITE
  );
}

/**
 * env 优先级：环境变量 THCLI_ENV > settings.json > "prod"。
 *
 * 不收命令行选项：环境是"这台机器当前对着哪套网关"的会话级状态，且两套环境的
 * 凭证不通用——允许单条命令切环境，只会让人拿着 A 环境的凭证打到 B 环境，
 * 报错还是看不出根因的那种。要切就整体切（thcli env use）。
 */
export function resolveEnv(): string {
  return process.env["THCLI_ENV"] || getSetting("env") || DEFAULT_ENV;
}

/** 读凭证文件，损坏时按空处理而不是让所有命令挂掉 */
export function readCredentialFile(profile: string, site: string): CredentialFile {
  try {
    return JSON.parse(fs.readFileSync(credentialPath(profile, site), "utf8")) as CredentialFile;
  } catch {
    return {};
  }
}

/** 读 per-profile 配置（{profile}.configure），损坏/缺失按空处理 */
export function readConfigure(profile: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configurePath(profile), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 按「整包三选一」解析凭证。region 例外——它与主凭证解耦，走字段级独立回退。
 */
export function parseGlobalArgs(args: GlobalArgs): ResolvedCredential {
  const profile = resolveProfile(args);
  const site = resolveSite(args);
  const file = readCredentialFile(profile, site);

  const candidates: Array<[ResolvedCredential["source"], ...(string | undefined)[]]> = [
    // 命令行不收 token：临时覆盖的场景是"手上有一对永久 AK/SK，临时用一下"，
    // 这类用户不接触会话令牌这个概念。要用临时密钥请走环境变量或 auth login。
    ["cli", args.secretId, args.secretKey, undefined],
    [
      "env",
      process.env["TENCENTCLOUD_SECRET_ID"],
      process.env["TENCENTCLOUD_SECRET_KEY"],
      process.env["TENCENTCLOUD_TOKEN"],
    ],
    ["file", file.secretId, file.secretKey, file.token],
  ];

  let source: ResolvedCredential["source"] = "none";
  let secretId: string | undefined;
  let secretKey: string | undefined;
  let token: string | undefined;

  for (const [name, id, key, tok] of candidates) {
    // 只看 id+key 是否齐全；齐全就整层锁定（含可能为空的 token），命中即停
    if (id && key) {
      source = name;
      secretId = id;
      secretKey = key;
      token = tok;
      break;
    }
  }

  // region 与主凭证解耦，可单独指定。优先级：命令行 > 环境变量 > per-profile
  // 配置（profile set --region 写入）> 凭证文件 > 默认
  const configuredRegion = readConfigure(profile)["region"];
  const region =
    args.region ||
    process.env["TENCENTCLOUD_REGION"] ||
    (typeof configuredRegion === "string" ? configuredRegion : undefined) ||
    file.region ||
    DEFAULT_CLOUD_REGION;

  return { profile, site, secretId, secretKey, token, region, source, raw: file };
}

/** 凭证脱敏：短于 8 位直接全遮，否则留头 4 尾 4 */
export function mask(value: string | undefined): string {
  if (!value) {
    return "";
  }
  if (value.length < 8) {
    return "***";
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

