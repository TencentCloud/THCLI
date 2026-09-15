/**
 * doctor 命令组：只读体检与诊断。不改任何资源。
 */
import { Command } from "commander";
import { isIP } from "node:net";

import { buildClient } from "../core/client.js";
import { allowedRegions, allowedSites, DEFAULT_REGION } from "../core/config.js";
import {
  mask,
  parseGlobalArgs,
  resolveProfile,
  resolveSite,
  type GlobalArgs,
} from "../core/credentials.js";
import { loadDataConfig, resolveRegionKey } from "../core/keystore.js";
import { CLOUD_CODES, ERROR_CODES, GATEWAY_CODES, lookupError } from "../core/errors.js";
import { human, pad, stopReasonAdvice } from "../core/format.js";
import { emitJson, emitJsonSafe, isJson } from "../core/output.js";
import { t } from "../core/i18n.js";
import { formatTokenSummary } from "../core/plan-format.js";

function checkCredential(globals: GlobalArgs): void {
  const cred = parseGlobalArgs(globals);
  if (cred.source === "none") {
    console.log(t("doctor.cred.none"));
    return;
  }
  if (cred.raw.type === "oauth" && cred.raw.expiresAt) {
    const remaining = cred.raw.expiresAt - Date.now() / 1000;
    if (remaining <= 0) {
      console.log(
        t("doctor.cred.expired", { when: new Date(cred.raw.expiresAt * 1000).toLocaleString() }),
      );
      return;
    }
  }
  console.log(
    t("doctor.cred.ok", {
      source: cred.source,
      profile: cred.profile,
      site: cred.site,
      secretId: mask(cred.secretId),
      type: cred.raw.type ?? "-",
    }),
  );
}

function checkSiteRegion(globals: GlobalArgs): void {
  const site = resolveSite(globals);
  if (!allowedSites().includes(site)) {
    console.log(t("doctor.site.bad", { site, options: allowedSites().join(", ") }));
    return;
  }
  console.log(t("doctor.site.ok", { site, regions: allowedRegions(site).join(", ") }));
}

async function checkControlPlane(globals: GlobalArgs): Promise<void> {
  try {
    const client = buildClient(globals);
    await client.call("DescribeApiKeyList", { Platform: "maas", Limit: 1 });
    console.log(t("doctor.api.ok"));
  } catch (err) {
    console.log(t("doctor.api.fail", { message: (err as Error).message }));
  }
}

function checkDataPlaneKey(globals: GlobalArgs): void {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  try {
    const key = resolveRegionKey(loadDataConfig(profile), site, DEFAULT_REGION, "th");
    if (key) {
      console.log(t("doctor.key.ok", { scope: `${site}/${DEFAULT_REGION}/th`, masked: mask(key) }));
    } else {
      console.log(
        t("doctor.key.missing", { scope: `${site}/${DEFAULT_REGION}/th` }),
      );
    }
  } catch (err) {
    console.log(t("doctor.key.readFail", { message: (err as Error).message }));
  }
}

/**
 * 体检各项的结构化结论，供 --json 用。
 *
 * 文本模式下每项检查直接打印人类可读结论；JSON 模式则要把同样的判断表达成
 * ok/detail，让调用方不必解析文案。两者共用同一份判断逻辑，避免结论分叉。
 */
function collectChecks(globals: GlobalArgs): Record<string, unknown> {
  const cred = parseGlobalArgs(globals);
  const site = resolveSite(globals);
  const profile = resolveProfile(globals);

  const credOk =
    cred.source !== "none" &&
    !(cred.raw.type === "oauth" && cred.raw.expiresAt && cred.raw.expiresAt - Date.now() / 1000 <= 0);

  let dataKey: string | undefined;
  let dataKeyError: string | undefined;
  try {
    dataKey = resolveRegionKey(loadDataConfig(profile), site, DEFAULT_REGION, "th");
  } catch (err) {
    dataKeyError = (err as Error).message;
  }

  return {
    Credential: {
      Ok: credOk,
      Source: cred.source,
      Profile: cred.profile,
      Site: cred.site,
      SecretId: mask(cred.secretId),
      Type: cred.raw.type ?? null,
      ExpiresAt: cred.raw.expiresAt ?? null,
    },
    SiteRegion: {
      Ok: allowedSites().includes(site),
      Site: site,
      AllowedRegions: allowedSites().includes(site) ? allowedRegions(site) : [],
    },
    DataPlaneKey: {
      Ok: Boolean(dataKey),
      Scope: `${site}/${DEFAULT_REGION}/th`,
      ApiKey: dataKey ? mask(dataKey) : null,
      Error: dataKeyError ?? null,
    },
  };
}

async function allCommand(globals: GlobalArgs): Promise<void> {
  if (isJson()) {
    // 管控面连通性要真发一次请求，单独测，不能只看本地状态
    const checks = collectChecks(globals);
    let apiOk = true;
    let apiError: string | null = null;
    try {
      await buildClient(globals).call("DescribeApiKeyList", { Platform: "maas", Limit: 1 });
    } catch (err) {
      apiOk = false;
      apiError = (err as Error).message;
    }
    emitJson({ ...checks, ControlPlane: { Ok: apiOk, Error: apiError } });
    return;
  }

  console.log(t("doctor.all.title", { site: resolveSite(globals) }));
  console.log("");
  checkCredential(globals);
  checkSiteRegion(globals);
  await checkControlPlane(globals);
  checkDataPlaneKey(globals);
  console.log("");
  console.log(
    t("doctor.all.footer"),
  );
}

/**
 * 取本机出口公网 IP，用于比对 Key 的 IP 白名单。
 *
 * 这会向第三方服务（ipify.org）发一次请求——云 API 没有"查我的出口 IP"这类接口，
 * 而白名单校验必须知道出口 IP 才能给出有用的结论。调用前先告知用户，别偷偷外发：
 * 出口 IP 虽不算机密，但把它送去哪里应当由用户看得见。
 */
async function egressIp(): Promise<string | undefined> {
  console.log(t("doctor.keyCheck.ipLookupNotice"));
  try {
    const resp = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await resp.json()) as { ip?: string };
    return body.ip;
  } catch {
    return undefined;
  }
}

/** 判断 ip 是否落在 entry（单 IP 或 CIDR）内 */
function ipMatches(ip: string, entry: string): boolean {
  if (!entry.includes("/")) {
    return ip === entry;
  }
  const [network, bitsRaw] = entry.split("/");
  const bits = Number(bitsRaw);
  if (!network || isIP(network) !== 4 || isIP(ip) !== 4 || Number.isNaN(bits)) {
    // IPv6 或格式异常时不做判断，交给上层按"无法确定"处理
    return false;
  }
  const toInt = (addr: string): number =>
    addr.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  const maskBits = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & maskBits) === (toInt(network) & maskBits);
}

async function keyCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "doctor key", args: "--id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeApiKey", { Platform: "maas", ApiKeyId: opts["id"] });
  const key = (resp["ApiKeyInfo"] ?? resp) as Record<string, unknown>;

  if (emitJsonSafe(key)) return;

  const status = String(key["Status"] ?? "");
  console.log(
    status === "enable"
      ? t("doctor.keyCheck.statusOk")
      : t("doctor.keyCheck.statusBad", { status, id: opts["id"] }),
  );
  const bindType = String(key["BindType"] ?? "-");
  const bindings = (key["BindingItems"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (bindType === "all") {
    console.log(t("doctor.keyCheck.scopeAll"));
  } else if (!bindings.length) {
    console.log(
      t("doctor.keyCheck.scopeEmpty", { bindType }),
    );
  } else {
    // 绑定的资源自身可能已下线，这种 Key 看着正常却调不通，值得单独指出
    const offline = bindings.filter((b) => String(b["Status"] ?? "").toLowerCase() !== "online");
    if (offline.length) {
      const names = offline.map((b) => String(b["ResourceId"])).join(", ");
      console.log(
        t("doctor.keyCheck.scopeOffline", { bindType, count: bindings.length, offline: offline.length, names }),
      );
    } else {
      console.log(t("doctor.keyCheck.scopeOk", { bindType, count: bindings.length }));
    }
  }

  // 额度是最常见的"看着正常却调不通"根因，必须逐条比对已用/总量
  const quotas = (key["QuotaSet"] as Array<Record<string, unknown>> | undefined) ?? [];
  const quotaStatus = String(key["QuotaStatus"] ?? "");
  if (!quotas.length) {
    console.log(t("doctor.keyCheck.quotaNone"));
  } else {
    for (const q of quotas) {
      const used = Number(q["CycleUsed"] ?? 0);
      const total = Number(q["CycleCredits"] ?? 0);
      const percent = total > 0 ? ((used / total) * 100).toFixed(2) : "-";
      const unit = String(q["CycleUnit"] ?? "");
      const cycle = t(`key.cycle.${unit}`).startsWith("key.cycle.") ? unit : t(`key.cycle.${unit}`);
      const detail = `${cycle} ${used.toLocaleString()}/${total.toLocaleString()} tokens（${percent}%）`;
      if (total > 0 && used >= total) {
        console.log(
          t("doctor.keyCheck.quotaExceeded", { detail, id: opts["id"] }),
        );
      } else {
        console.log(t("doctor.keyCheck.quotaOk", { detail }));
      }
    }
    if (quotaStatus === "inactive") {
      console.log(t("doctor.keyCheck.quotaInactive"));
    }
  }

  const whitelist = (key["IpWhitelist"] as string[] | undefined) ?? [];
  if (!whitelist.length) {
    console.log(t("doctor.keyCheck.ipNone"));
    return;
  }
  const ip = await egressIp();
  if (!ip) {
    console.log(t("doctor.keyCheck.ipUnknown", { list: whitelist.join(", ") }));
    return;
  }
  if (whitelist.some((entry) => ipMatches(ip, entry))) {
    console.log(t("doctor.keyCheck.ipHit", { ip }));
  } else {
    console.log(
      t("doctor.keyCheck.ipMiss", { ip, list: whitelist.join(", "), id: opts["id"] }),
    );
  }
}

async function endpointCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "doctor endpoint", args: "--id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeEndpoint", { EndpointId: opts["id"] });
  const e = (resp["Endpoint"] ?? resp) as Record<string, unknown>;

  if (emitJson(e)) return;

  console.log(
    t("doctor.endpointCheck.header", {
      name: e["EndpointName"] ?? "",
      id: e["EndpointId"] ?? "",
      status: e["Status"] ?? "",
      chargeType: e["ChargeType"] ?? "-",
      postpaid: e["PaymentEnabled"] ? "on" : "off",
    }),
  );
  const status = String(e["Status"] ?? "").toUpperCase();
  if (status === "ACTIVE" || status === "RUNNING") {
    console.log(t("doctor.endpointCheck.running"));
    return;
  }
  const reason = String(e["StopReason"] ?? "");
  const advice =
    stopReasonAdvice(reason, String(e["EndpointId"] ?? "")) ||
    t("doctor.endpointCheck.adviceFallback");
  console.log(
      t("doctor.endpointCheck.stopped", {
        reason: reason || t("doctor.endpointCheck.reasonUnknown"),
        advice,
      }),
    );
}

async function modelCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "doctor model", args: "--id" }));
  const client = buildClient(globals);
  const listResp = await client.call("DescribeModelList", { ModelIds: [opts["id"]] });
  const models = (listResp["ModelSet"] as Array<Record<string, unknown>> | undefined) ?? [];
  const model = models.find((m) => m["ModelId"] === opts["id"]);
  if (!model) {
    if (emitJson(null)) return;
    console.log(t("doctor.modelCheck.notFound", { id: opts["id"] }));
    return;
  }
  // 这行在两次调用之间，JSON 模式必须跳过，否则 stdout 变成「一行人话 + JSON」
  if (!isJson()) {
    console.log(
      t("doctor.modelCheck.found", {
        name: model["ModelName"] ?? "",
        id: model["ModelId"] ?? "",
        status: model["Status"] ?? "",
      }),
    );
  }

  const epResp = await client.call("DescribeModelEndpointList", {
    Filters: [{ Name: "ModelId", Op: "EXACT", Values: [opts["id"]] }],
  });
  const endpoints = (epResp["ModelEndpointSet"] as Array<Record<string, unknown>> | undefined) ?? [];
  const active = endpoints.filter((e) => {
    const s = String(e["Status"] ?? "").toUpperCase();
    return s === "ACTIVE" || s === "RUNNING";
  });

  // 诊断结论由「模型 + 其端点」共同决定，两者一起给出，调用方不必再猜
  if (
    emitJson({
      Model: model,
      Endpoints: endpoints,
      ActiveEndpointCount: active.length,
    })
  ) {
    return;
  }

  if (!endpoints.length) {
    console.log(t("doctor.modelCheck.noEndpoint"));
  } else if (!active.length) {
    console.log(
      t("doctor.modelCheck.noneActive", { count: endpoints.length }),
    );
  } else {
    console.log(t("doctor.modelCheck.ok", { count: endpoints.length, active: active.length }));
  }
  console.log(t("doctor.modelCheck.note"));
}

async function planCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("arg.missing", { command: "doctor plan", args: "--team-id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeTokenPlan", { TeamId: opts["teamId"] });
  const p = (resp["Team"] ?? resp) as Record<string, unknown>;

  if (emitJson(p)) return;

  console.log(
    t("doctor.planCheck.header", {
      name: p["Name"] ?? "",
      id: p["TeamId"] ?? "",
      productType: p["ProductType"] ?? "",
    }),
  );
  const status = String(p["Status"] ?? "");
  const stopReason = String(p["StopReason"] ?? "");
  if (status === "enable" && (!stopReason || stopReason === "NORMAL")) {
    console.log(t("doctor.planCheck.statusOk"));
  } else {
    console.log(t("doctor.planCheck.statusBad", { status, stopReason: stopReason || "-" }));
  }
  const productType = String(p["ProductType"] ?? "");
  // 专业版按积分计价、轻享版按 token，标错单位会让人误以为额度算错了
  const unit = productType === "enterprise" ? t("plan.unit.credit") : t("plan.unit.token");
  const pkg = (p["PackageInfo"] ?? {}) as Record<string, unknown>;
  if (Object.keys(pkg).length) {
    const total = Number(pkg["TotalQuota"] ?? pkg["TotalCredits"] ?? 0);
    const used = Number(pkg["TotalUsed"] ?? 0);
    const percent = total > 0 ? (used / total) * 100 : 0;
    const detail = `${human(used)} / ${human(total)} ${unit}（${percent.toFixed(2)}%）`;
    // 快用完时提前预警，别等真的调不通了才发现
    if (total > 0 && used >= total) {
      console.log(t("doctor.planCheck.quotaExhausted", { detail }));
    } else if (percent >= 80) {
      console.log(t("doctor.planCheck.quotaLow", { detail }));
    } else {
      console.log(t("doctor.keyCheck.quotaOk", { detail }));
    }
  }

  const summary = (p["TokenSummary"] ?? {}) as Record<string, unknown>;
  if (Object.keys(summary).length) {
    for (const line of formatTokenSummary(summary, productType)) {
      console.log(`   ${line}`);
    }
  }
}

/** 打印全部收录的错误码清单（不含详情） */
function listErrorCodes(): void {
  console.log(t("doctor.error.listHeader", { count: ERROR_CODES.length }));
  // 分两组打印：管控面码是字母命名空间、数据面码是六位数字，混排时看不出这是两套体系，
  // 也看不出自己手上的码该在哪一组里找
  for (const [title, codes] of [
    [t("doctor.error.groupCloud"), CLOUD_CODES],
    [t("doctor.error.groupGateway"), GATEWAY_CODES],
  ] as Array<[string, string[]]>) {
    console.log("");
    console.log(`  ${title}`);
    for (const code of codes) {
      const info = lookupError(code);
      console.log(`    ${pad(code, 34)} ${info?.reason ?? ""}`);
    }
  }
  console.log("");
  console.log(t("doctor.error.listFooter"));
}

function errorCommand(code: string | undefined): void {
  // 不给 code 就列出收录了哪些，而不是报错——这是用户最常见的"我想知道有哪些"诉求
  if (!code) {
    listErrorCodes();
    return;
  }

  const exact = ERROR_CODES.includes(code) ? lookupError(code) : undefined;
  if (exact) {
    console.log(code);
    console.log(`  ${t("error.reason", { reason: exact.reason })}`);
    console.log(`  ${t("error.fix", { fix: exact.fix })}`);
    return;
  }
  // 没有全等命中就按前缀找，便于只知道大类时也能查到（如输 AuthFailure 列出所有子码）
  const prefixed = ERROR_CODES.filter((k) => k.startsWith(code));
  if (prefixed.length) {
    for (const k of prefixed) {
      const info = lookupError(k);
      console.log(k);
      console.log(`  ${t("error.reason", { reason: info?.reason ?? "" })}`);
      console.log(`  ${t("error.fix", { fix: info?.fix ?? "" })}`);
    }
    return;
  }
  // 没命中就把收录清单亮出来，用户能立刻看到该查哪个，而不是干瞪眼
  console.log(t("doctor.error.notFound", { code }));
  console.log("");
  listErrorCodes();
}

/** 装配 doctor 命令组 */
export function registerDoctorCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const doctor = program.command("doctor").description(t("group.doctor.desc"));

  // isDefault：裸跑 `thcli doctor` 直接体检，不打 help。「doctor 就是体检」是用户
  // 和文档的共同预期，多敲一个 all 只是仪式；`doctor all` 仍然可用。
  doctor
    .command("all", { isDefault: true })
    .description(t("doctor.all.desc"))
    .action(async () => allCommand(getGlobals()));

  doctor
    .command("key")
    .description(t("doctor.key.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .action(async (opts) => keyCommand(opts, getGlobals()));

  doctor
    .command("endpoint")
    .description(t("doctor.endpoint.desc"))
    .requiredOption("--id <id>", "EndpointId")
    .action(async (opts) => endpointCommand(opts, getGlobals()));

  doctor
    .command("model")
    .description(t("doctor.model.desc"))
    .requiredOption("--id <id>", "ModelId")
    .action(async (opts) => modelCommand(opts, getGlobals()));

  doctor
    .command("plan")
    .description(t("doctor.plan.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .action(async (opts) => planCommand(opts, getGlobals()));

  doctor
    .command("error")
    .description(t("doctor.error.desc"))
    .argument("[code]", t("doctor.error.arg"))
    .action((code: string | undefined) => errorCommand(code));
}
