/**
 * 非机密的基础设施配置：站点 → 授权门户（app_id/auth_url/鉴权后端）、站点 → 地域 → 数据面 host。
 *
 * 三层覆盖，优先级从高到低：
 *   1. 环境变量 THCLI_AUTH_BACKEND / THCLI_AUTH_BACKEND_INTL —— 临时指向别的鉴权后端；
 *      THCLI_AUTH_APP_ID / THCLI_AUTH_APP_ID_INTL —— 临时换 OAuth 应用（排查授权失败用）
 *   2. ~/.thcli/config.json —— 按字段局部覆盖（深合并，只写想改的那几项即可）
 *   3. 内置默认值（下方 DEFAULT_CONFIG）
 *
 * 为什么支持局部覆盖：鉴权后端域名会随环境变化（测试 → 预发 → 线上），
 * 若要求整份替换，用户为改一个域名得抄一整份配置，容易抄漏且难维护。
 */
import fs from "node:fs";

import { t } from "./i18n.js";
import { USER_CONFIG_PATH } from "./paths.js";

/** 站点的 OAuth 授权门户信息 */
export interface Portal {
  /** OAuth 应用 app_id（国内站/国际站各申请一次，值不同） */
  appId: number;
  /** 授权页地址 */
  authUrl: string;
  /**
   * 鉴权后端的基址。回调中转在 {authBackend}{callbackPath}，
   * 换令牌/临时密钥的两个接口在 {authBackend}{tokenPathPrefix} 下面。
   */
  authBackend: string;
  /**
   * 授权回调路径（腾讯云授权后跳到 authBackend + 这个路径）。
   * 自建中转后端 = /cli/auth；腾讯云公共后端 = /oauth。
   */
  callbackPath: string;
  /**
   * 换令牌/临时密钥接口的路径前缀。
   * 自建中转后端 = /cli（接口在 /cli/get_temp_cred）；
   * 公共后端接口挂在根下，配空串。
   */
  tokenPathPrefix: string;
  /** 授权页语言。国内站 zh-CN、国际站 en-US */
  lang: string;
}

/** 单个地域的配置 */
export interface RegionConfig {
  /** 数据面推理接口的 host */
  chatHost: string;
  /**
   * TokenPlan（`--plan`）专用 origin，按 **plan 类型 → 环境** 两层指定。
   *
   * 为什么不能复用 chatHost：同一个地域下两种套餐落在不同服务上——国内站个人版
   * （sk-tp）走 lkeap 那套独立网关，企业版（sk-tp-ep）仍在 chatHost 上。所以
   * 键必须带 plan 类型，只按地域区分不出来。
   *
   * 也不能复用 chatHostPrefix：lkeap 的 test 与 prod 是 api. → testapi. 的**替换**，
   * 不是加前缀。
   *
   * 只有"与 chatHost 不同"的组合才配这一项，其余留空自动回落 chatHost
   * （企业版全部、以及国际站个人版都靠回落）。值可带 scheme，不带按 https。
   */
  planHost?: Record<string, Record<string, string>>;
}

/** 单个站点的配置 */
export interface SiteConfig {
  portal: Portal;
  regions: Record<string, RegionConfig>;
}

/**
 * 环境相关的基础设施。prod 与 test 是两套独立的网关，凭证不通用：
 * 测试环境的临时密钥拿到正式网关会报 AuthFailure.TokenFailure（不是过期，是环境不匹配）。
 */
export interface EnvConfig {
  /**
   * 管控面云 API host。留空表示用 SDK 内置的正式地址。
   */
  apiEndpoint?: string;
  /**
   * 其它云产品（cam / monitor / sts）的 host 中缀，如 "test." →
   * cam.test.tencentcloudapi.com。留空即用正式地址。
   */
  cloudApiInfix?: string;
  /**
   * 云 API 的域名后缀，默认 tencentcloudapi.com。
   * 供域名后缀不同的自建/私有化环境覆盖，留空按正式取。
   */
  cloudApiSuffix?: string;
  /**
   * 强制把云 API 域名解析到这个 IP（相当于内置一条 hosts）。
   *
   * 为什么需要：某些环境里 SSE 集群与普通接口集群是两套，DNS 默认解析到后者，
   * 而流式请求必须打到前者。官方给的办法是本地配 hosts —— 走这个字段就不必改
   * 系统文件，也不会影响同机其它程序。
   *
   * 实现上仍以域名发请求（Host 头、TLS SNI、签名都用域名），只替换连接的目标 IP。
   */
  cloudApiHostIp?: string;
  /**
   * 数据面 host 的前缀（test 环境是 "test-"）。拼在 chatHost 前面，
   * 例如 tokenhub.tencentmaas.com → test-tokenhub.tencentmaas.com。
   */
  chatHostPrefix?: string;
  /**
   * 是否跳过 TLS 证书校验。**仅供证书确实有问题的非正式环境**（证书过期、CN 不匹配
   * 但接口本身可用）。
   *
   * 为什么默认不开、也不做成全局开关：关掉校验等于放弃中间人防护，攻击者能截获
   * access_token。所以收敛到"单个环境显式声明"，并且 prod 一律强制忽略该字段
   * （见 insecureTlsOf）——正式环境无论如何配置都会校验证书。
   *
   * 开启时每次请求前会向用户打印告警，避免不知情地在无保护的连接上传令牌。
   */
  insecureTls?: boolean;
  /**
   * 请求是否携带 X-Qcloud-User-Id 头。部分非正式网关不从临时密钥反查账号，
   * 缺这个头时会返回 InternalError。正式环境不需要。
   *
   * 安全性：该头只是路由提示，不是身份凭据——实测填别人的 uin 拿不到任何数据
   * （网关仍按签名密钥校验真实身份，伪造只会得到 InternalError）。
   */
  routeByUserId?: boolean;
}

/** 全量配置 */
export interface ThcliConfig {
  sites: Record<string, SiteConfig>;
  envs: Record<string, EnvConfig>;
}

/** 缺省站点 */
export const DEFAULT_SITE = "cn";

/** 缺省环境。不配就是正式环境——测试环境必须显式切，避免误连 */
export const DEFAULT_ENV = "prod";

/** 缺省地域（数据面 area，不是管控面 region） */
export const DEFAULT_REGION = "gz";

/** 管控面云 API 的缺省地域 */
export const DEFAULT_CLOUD_REGION = "ap-guangzhou";

// 鉴权走自建的 OAuth 中转后端（两站各一个部署，各持对应站点的应用密钥）：
// callbackPath /cli/auth 是授权回调中转，tokenPathPrefix /cli 下挂
// get_temp_cred、refresh_user_token 两个换取接口。
//
// DEFAULT_CONFIG 里配的是生产域名（thcli-{cn,intl}.tencentmaas.com），走公网可达。
// 测试环境用的是 test- 前缀的那两个域名，需能访问该网关的网络环境 + 测试 hosts 才能解析，
// 直连公网连不上（表现为授权页报「登录授权参数无效」，因为门户侧也访问不到那个回调
// 域名）——在测试环境排查时先确认网络，别误判成 app_id 或回调白名单的问题。
// 切测试环境靠 THCLI_AUTH_BACKEND / THCLI_AUTH_BACKEND_INTL 覆盖，见下方环境变量。
//
// 生产与测试是两套独立的 OAuth 应用（appId 不同），登录态不通用：换了域名就必须
// 重新 login，拿旧环境的凭证打新环境只会得到签名校验失败。
//
// 若换临时密钥时报 InternalError.UnknownError: strategy is empty，是 OAuth 应用在
// STS 侧缺权限策略——该策略随应用配置下发、接口不允许调用方传，CLI 侧无法绕过，
// 补齐后重新 login 即可。
//
// 若要临时切到腾讯云公共鉴权后端（走公网即可，可用来隔离网络因素或验证 CLI 侧
// 拼参无误），四项须一起换，只改域名不改路径会 404：
//
//	         appId          authBackend                     callbackPath  tokenPathPrefix
//	cn       100038427476   https://cli.cloud.tencent.com   /oauth        ""
//	intl     200038425648   https://cli.cloud.tencent.com   /oauth        ""
//
// 公共后端两站共用同一地址，由请求体里的 Site 参数区分。取值来源：
// 公共后端两站共用同一地址，由请求体里的 Site 参数区分。切换无需改码，用
// THCLI_AUTH_APP_ID /
// THCLI_AUTH_BACKEND / THCLI_AUTH_CALLBACK_PATH / THCLI_AUTH_PATH_PREFIX 覆盖
// （四个须成组一起给）。
//
// 数据面 chatHost 由两个独立维度拼成，不是"国内站只有国内地域"那种嵌套关系：
//   主域   站点决定 —— 国内站 tencentmaas.com / 国际站 tencentcloudmaas.com
//   -intl  地域决定 —— 广州无后缀 / 新加坡带 -intl
// 所以「国内广州」和「国际广州」是两个不同的 host，不能只按地域取值。
// test 环境在此基础上再加 test- 前缀（见 EnvConfig.chatHostPrefix）。
const DEFAULT_CONFIG: ThcliConfig = {
  sites: {
    cn: {
      portal: {
        appId: 100052648675,
        authUrl: "https://cloud.tencent.com/open/authorize",
        authBackend: "https://thcli-cn.tencentmaas.com",
        callbackPath: "/cli/auth",
        tokenPathPrefix: "/cli",
        lang: "zh-CN",
      },
      regions: {
        gz: {
          chatHost: "tokenhub.tencentmaas.com",
          // 个人版国内站是唯一与 chatHost 不同的组合：走 lkeap 独立网关。
          // 企业版不配 → 回落 chatHost（tokenhub.tencentmaas.com），那是对的。
          // 只列 prod；非正式环境的 host 同样走 ~/.thcli/config.json 补充
          planHost: {
            tp: {
              prod: "api.lkeap.cloud.tencent.com",
            },
          },
        },
        sg: { chatHost: "tokenhub-intl.tencentmaas.com" },
      },
    },
    intl: {
      portal: {
        appId: 200052672966,
        // 国际站授权页地址与国内站不同域。
        // 注意国际站路径多一段 /account，与国内站不是简单的域名替换关系。
        authUrl: "https://www.tencentcloud.com/account/open/authorize",
        authBackend: "https://thcli-intl.tencentmaas.com",
        callbackPath: "/cli/auth",
        tokenPathPrefix: "/cli",
        lang: "en-US",
      },
      regions: {
        gz: { chatHost: "tokenhub.tencentcloudmaas.com" },
        sg: { chatHost: "tokenhub-intl.tencentcloudmaas.com" },
      },
    },
  },
  // 环境相关的基础设施。这里只内置 prod：全部留空 = 用 SDK 内置正式地址、
  // 数据面不加前缀、不注入 X-Qcloud-User-Id。
  //
  // 非正式环境不写进代码——它们是部署方自己的基础设施（私有网络地址、集群 IP、
  // 证书状况），既不该编进分发给用户的产物，也会随环境调整而过期。改为在
  // ~/.thcli/config.json 里按 EnvConfig 的字段自行声明。用户配置与这里是
  // deepMerge，新增 env 直接生效，无需改码。
  envs: {
    prod: {},
  },
};

let cached: ThcliConfig | undefined;

/** 可被单个环境变量覆盖 authBackend 的站点映射 */
const BACKEND_ENV_BY_SITE: Record<string, string> = {
  cn: "THCLI_AUTH_BACKEND",
  intl: "THCLI_AUTH_BACKEND_INTL",
};

/**
 * 覆盖 appId 的环境变量。用于临时切到另一套 OAuth 应用（如公共后端那套，
 * 须与 authBackend、路径前缀一起换），排查授权失败时可借此隔离变量。
 */
const APP_ID_ENV_BY_SITE: Record<string, string> = {
  cn: "THCLI_AUTH_APP_ID",
  intl: "THCLI_AUTH_APP_ID_INTL",
};

/**
 * 覆盖接口路径的环境变量。公共后端与自建后端的路径布局不同
 * （公共：/oauth + 根下接口；自建：/cli/auth + /cli 下接口），切换时要一起换。
 */
const PATH_ENV_BY_SITE: Record<string, { callback: string; prefix: string }> = {
  cn: { callback: "THCLI_AUTH_CALLBACK_PATH", prefix: "THCLI_AUTH_PATH_PREFIX" },
  intl: { callback: "THCLI_AUTH_CALLBACK_PATH_INTL", prefix: "THCLI_AUTH_PATH_PREFIX_INTL" },
};

/** 深合并：override 里出现的字段覆盖 base，未出现的保留 base 的值 */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return (override === undefined ? base : (override as T));
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = result[key];
    result[key] =
      current !== null && typeof current === "object" && !Array.isArray(current)
        ? deepMerge(current, value)
        : value;
  }
  return result as T;
}

/** 读取配置，进程内缓存一次。合并顺序见文件头注释 */
export function loadConfig(): ThcliConfig {
  if (cached) {
    return cached;
  }
  let merged: ThcliConfig = DEFAULT_CONFIG;

  // 第 2 层：用户配置文件按字段局部覆盖
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf8");
    merged = deepMerge(merged, JSON.parse(raw));
  } catch {
    // 文件不存在或格式不对都退回上一层，不让配置问题挡住所有命令
  }

  // 第 1 层：环境变量覆盖鉴权后端地址与路径前缀——它们是最常需要临时改的
  // （切测试/预发/线上后端，或临时切回腾讯云公共后端）
  for (const [site, envKey] of Object.entries(BACKEND_ENV_BY_SITE)) {
    const value = process.env[envKey];
    if (value && merged.sites[site]) {
      merged.sites[site]!.portal.authBackend = value;
    }
  }
  for (const [site, envKey] of Object.entries(APP_ID_ENV_BY_SITE)) {
    const value = Number(process.env[envKey]);
    // 非数字（含空串）一律忽略：appId 写错成 0 或 NaN 会让 portalOf 报「配置不全」，
    // 反而掩盖真正的问题
    if (Number.isInteger(value) && value > 0 && merged.sites[site]) {
      merged.sites[site]!.portal.appId = value;
    }
  }
  for (const [site, envKeys] of Object.entries(PATH_ENV_BY_SITE)) {
    const portal = merged.sites[site]?.portal;
    if (!portal) {
      continue;
    }
    const callback = process.env[envKeys.callback];
    if (callback) {
      portal.callbackPath = callback;
    }
    // 前缀允许设为空串（公共后端接口挂在根下），故用 !== undefined 而非真值判断
    const prefix = process.env[envKeys.prefix];
    if (prefix !== undefined) {
      portal.tokenPathPrefix = prefix;
    }
  }

  cached = merged;
  return cached;
}

/** 可用站点列表 */
export function allowedSites(): string[] {
  return Object.keys(loadConfig().sites).sort();
}

/** 可用环境列表 */
export function allowedEnvs(): string[] {
  return Object.keys(loadConfig().envs);
}

/** 取环境的基础设施配置。未知环境按缺省环境处理，不让配置问题挡住所有命令 */
export function envConfigOf(env: string): EnvConfig {
  return loadConfig().envs[env] ?? loadConfig().envs[DEFAULT_ENV] ?? {};
}

/**
 * 管控面云 API host。返回 undefined 表示用 SDK 内置的正式地址
 * （调用方据此决定是否传 endpoint，而不是传空串）。
 * THCLI_API_ENDPOINT 优先，便于临时指到别的网关而不改设置。
 */
export function apiEndpointOf(env: string): string | undefined {
  return process.env["THCLI_API_ENDPOINT"] || envConfigOf(env).apiEndpoint;
}

/**
 * 其它云产品（cam / monitor / sts）在当前环境的 host。
 * product 传 "cam" 得到 cam.tencentcloudapi.com 或 cam.test.tencentcloudapi.com。
 */
/**
 * 是否对该环境跳过 TLS 校验。
 *
 * 缺省环境（prod）永远返回 false，无论配置里写了什么——把"漏到生产"从"取决于
 * 用户别配错"变成代码层面不可能。
 */
/** 该环境要强制解析到的 IP，无则返回 undefined（走正常 DNS） */
export function cloudApiHostIpOf(env: string): string | undefined {
  return envConfigOf(env).cloudApiHostIp;
}

export function insecureTlsOf(env: string): boolean {
  if (env === DEFAULT_ENV) {
    return false;
  }
  return envConfigOf(env).insecureTls === true;
}

export function cloudApiHostOf(env: string, product: string): string {
  const conf = envConfigOf(env);
  const suffix = conf.cloudApiSuffix ?? "tencentcloudapi.com";
  return `${product}.${conf.cloudApiInfix ?? ""}${suffix}`;
}

/** 授权回调地址：腾讯云授权完成后跳这里，必须是已登记的回调域名 */
export function callbackUrlOf(site: string): string {
  const portal = portalOf(site);
  return portal.authBackend.replace(/\/$/, "") + portal.callbackPath;
}

/** 换令牌/临时密钥接口的基址，后面直接接 /get_temp_cred 等 */
export function tokenBaseOf(site: string): string {
  const portal = portalOf(site);
  return portal.authBackend.replace(/\/$/, "") + portal.tokenPathPrefix;
}

/** 取站点的授权门户，站点未知或配置不全时抛错 */
export function portalOf(site: string): Portal {
  const conf = loadConfig().sites[site];
  const portal = conf?.portal;
  if (!portal?.appId || !portal.authUrl || !portal.authBackend || !portal.callbackPath) {
    throw new Error(
      t("config.portalIncomplete", { site }),
    );
  }
  if (portal.tokenPathPrefix === undefined) {
    throw new Error(t("config.missingPrefix", { site }));
  }
  return portal;
}

/** 站点下的可用地域 */
export function allowedRegions(site: string): string[] {
  const conf = loadConfig().sites[site];
  return conf ? Object.keys(conf.regions).sort() : [];
}

/**
 * 取站点+地域的数据面 host。env 决定是否加环境前缀
 * （test 环境是 test-tokenhub.xxx，与管控面换 endpoint 的做法不同）。
 */
export function chatHostOf(site: string, region: string, env: string = DEFAULT_ENV): string {
  const host = loadConfig().sites[site]?.regions[region]?.chatHost;
  if (!host) {
    const available = allowedRegions(site).join(", ") || t("common.none");
    throw new Error(t("config.noRegion", { site, region, options: available }));
  }
  return (envConfigOf(env).chatHostPrefix ?? "") + host;
}

/**
 * TokenPlan 只在这些站点+地域组合上有网关。
 *
 * 其余组合（国内站+新加坡、国际站+广州）根本不提供 TokenPlan——过去会照常拼出
 * 一个不存在的地址发出去，用户拿到的是连接层报错，看不出根因是"这个组合没有该服务"。
 */
const PLAN_REGIONS: Record<string, string[]> = { cn: ["gz"], intl: ["sg"] };

/**
 * `--plan` 通道的 origin（含 scheme）。先校验站点/地域组合是否提供 TokenPlan，
 * 再按 plan 类型取专用 host；没有专用配置的一律回落数据面 chatHost。
 */
export function planOriginOf(
  planType: string,
  site: string,
  region: string,
  env: string = DEFAULT_ENV,
): string {
  const allowed = PLAN_REGIONS[site] ?? [];
  if (!allowed.includes(region)) {
    throw new Error(
      t("config.noPlanRegion", {
        site,
        region,
        options: Object.entries(PLAN_REGIONS)
          .map(([s, rs]) => `${s}/${rs.join(",")}`)
          .join("  "),
      }),
    );
  }
  const explicit = loadConfig().sites[site]?.regions[region]?.planHost?.[planType]?.[env];
  if (explicit) {
    return /^https?:\/\//.test(explicit) ? explicit : `https://${explicit}`;
  }
  return `https://${chatHostOf(site, region, env)}`;
}
