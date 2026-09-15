/**
 * 云 API 请求用的 https agent。
 *
 * 单独成一个模块而不是放在 client.ts 里：cam / monitor 这些"其它云产品"的调用点
 * （identity.ts、monitor.ts）也要用同一个 agent，而 client.ts 反过来依赖
 * identity.ts 的 resolveIdentity —— 放在 client.ts 会形成循环依赖。
 *
 * 曾经漏掉这一层：identity.ts 直接 new CommonClient 而不带 agent，于是配了
 * cloudApiHostIp 的环境下该字段不生效，cam 请求被 DNS 解析到另一个集群，
 * 那台机器 443 端口不说 TLS，报 "wrong version number"。
 */
import https from "node:https";

import { cloudApiHostIpOf, insecureTlsOf } from "./config.js";
import { t } from "./i18n.js";

/**
 * 按环境构造 https agent。两件事都只在测试环境用得上：
 *   rejectUnauthorized:false —— 跳过过期证书（见 EnvConfig.insecureTls）
 *   lookup                   —— 把域名强制解析到指定 IP（见 EnvConfig.cloudApiHostIp）
 *
 * 用 lookup 而不是直接把 URL 换成 IP：域名仍然出现在 Host 头、TLS SNI 和签名里，
 * 只有底层连接的目标 IP 被替换。换成 IP 会导致 Host 头变成 IP、签名跟着变，网关认不出。
 *
 * agent 按 (insecure, ip) 缓存复用——每次 new 会丢掉连接池。
 */
const agentCache = new Map<string, https.Agent>();

function agentFor(insecure: boolean, hostIp?: string): https.Agent | undefined {
  if (!insecure && !hostIp) {
    return undefined;
  }
  const key = `${insecure}|${hostIp ?? ""}`;
  let agent = agentCache.get(key);
  if (!agent) {
    agent = new https.Agent({
      ...(insecure ? { rejectUnauthorized: false } : {}),
      ...(hostIp
        ? {
            // Node 传 options.all=true 时要求回数组形态；只回单个地址会得到
            // "Invalid IP address: undefined"（两种形态都要支持）
            lookup: ((
              _hostname: string,
              options: { all?: boolean },
              callback: (
                err: Error | null,
                address: string | Array<{ address: string; family: number }>,
                family?: number,
              ) => void,
            ): void => {
              if (options?.all) {
                callback(null, [{ address: hostIp, family: 4 }]);
                return;
              }
              callback(null, hostIp, 4);
            }) as unknown as https.AgentOptions["lookup"],
          }
        : {}),
    });
    agentCache.set(key, agent);
  }
  return agent;
}

/** 进程内只提示一次，避免一条命令里 40 处调用点各刷一遍 */
let warnedInsecureTls = false;

/**
 * 取该环境的 agent，没有特殊需求时返回 undefined（让 SDK 用默认连接）。
 *
 * 跳过证书校验必须让用户看见——静默跳过最危险，用户会忘了自己开着。
 */
export function agentForEnv(env: string): https.Agent | undefined {
  const insecure = insecureTlsOf(env);
  if (insecure && !warnedInsecureTls) {
    warnedInsecureTls = true;
    console.warn(t("tls.insecureWarning", { env }));
  }
  return agentFor(insecure, cloudApiHostIpOf(env));
}
