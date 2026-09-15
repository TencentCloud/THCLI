/**
 * key 命令组：API 密钥的增删改查。
 *
 * list 是复数语义的列表；其余动词都针对单个资源。scope（改绑定范围）依赖的
 * ModifyApiKeyBinding 目前无可用接口，打印说明而不伪造调用。
 */
import { Command } from "commander";

import { buildClient, type Client } from "../core/client.js";
import { mask, type GlobalArgs } from "../core/credentials.js";
import { parseJsonList, printAligned, printTable, splitCsv, summaryLine } from "../core/format.js";
import { emitJson, emitJsonSafe } from "../core/output.js";
import { confirm } from "../core/prompt.js";
import { t } from "../core/i18n.js";

const PLATFORM = "maas";

/**
 * 对外暴露的可访问范围。只有两档，刻意比后端窄。
 *
 * 后端的 BindType 认 4 个值（另有 model_all_endpoint_custom /
 * model_custom_endpoint_all 两种混合模式），但产品上不支持这两种，CLI 主动拦掉：
 * 让用户配出一个产品不支持的组合，比早点报错糟得多。
 */
const SCOPES = ["all", "custom"];

/**
 * 把 --targets 里的 ID 组装成后端的 Bindings。
 *
 * 不区分模型还是服务，一律 ResourceType: "endpoint"——授权最终都落到 endpoint 上。
 * 实测后端在该类型下按前缀分派：`ep-` 开头查服务，否则按模型名查（传不存在的模型报
 * "model(xxx) not found"，传不存在的服务报 "endpoint not found"，是两条查表路径）。
 * 给模型名就等于授权它的默认在线推理服务，即模型级访问。
 *
 * 所以 CLI 既不暴露 ResourceType，也不让用户操心传的是哪种 ID。
 */
function buildBindings(targets: string[]): Array<Record<string, string>> {
  return targets.map((id) => ({ ResourceType: "endpoint", ResourceId: id }));
}

interface ApiKey {
  ApiKeyId?: string;
  Name?: string;
  ApiKey?: string;
  Platform?: string;
  Status?: string;
  BindType?: string;
  CreateTime?: string;
  UpdateTime?: string;
  Uin?: string;
  SubUin?: string;
  Remark?: string;
  Editable?: boolean;
  IpWhitelist?: string[];
  /** active（额度正常）/ inactive（额度已停用，通常是用超了） */
  QuotaStatus?: string;
  /** 绑定的资源清单（BindType 非 all 时才有内容） */
  BindingItems?: Array<Record<string, unknown>>;
  /** 额度配置（未配额度时字段不出现） */
  QuotaSet?: Array<Record<string, unknown>>;
}

/** 额度周期单位 → 中文 */
/** 计费周期单位，文案在 locales（key.cycle.*）。未收录的原样回显 */
function cycleUnit(code: string): string {
  const label = t(`key.cycle.${code}`);
  return label.startsWith("key.cycle.") ? code : label;
}

/** 额度记录的 Status 码。1=正常、5=已用尽（实测值） */
/** 额度状态码 → 显示名，文案在 locales（key.quotaStatus.*）。未收录的原样回显 */
function quotaStatusName(code: number): string {
  const label = t(`key.quotaStatus.${code}`);
  return label.startsWith("key.quotaStatus.") ? String(code) : label;
}

/** 把一条额度记录渲染成「已用/总量（百分比）」 */
function quotaUsage(q: Record<string, unknown>): { text: string; exceeded: boolean } {
  const used = Number(q["CycleUsed"] ?? 0);
  const total = Number(q["CycleCredits"] ?? 0);
  const percent = total > 0 ? ((used / total) * 100).toFixed(2) : "-";
  const unit = cycleUnit(String(q["CycleUnit"] ?? ""));
  return {
    text: t("key.quotaUsage", {
      unit,
      used: used.toLocaleString(),
      total: total.toLocaleString(),
      percent,
    }),
    exceeded: total > 0 && used >= total,
  };
}

async function listCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = buildClient(globals);
  const params: Record<string, unknown> = { Platform: opts["platform"] ?? PLATFORM };
  const filters: Array<Record<string, unknown>> = [];

  if (opts["status"]) filters.push({ Name: "status", Op: "EXACT", Values: [opts["status"]] });
  if (opts["id"]) filters.push({ Name: "apikeyId", Op: "EXACT", Values: [opts["id"]] });
  if (opts["bindType"]) filters.push({ Name: "bindType", Op: "EXACT", Values: [opts["bindType"]] });
  // 名称按模糊匹配，便于只记得片段时也能查到
  if (opts["name"]) filters.push({ Name: "apiKeyName", Op: "FUZZY", Values: [opts["name"]] });
  if (filters.length) params["Filters"] = filters;

  if (opts["order"]) {
    const order = opts["order"].toLowerCase();
    if (order !== "asc" && order !== "desc") {
      throw new Error(t("arg.badOrder"));
    }
    params["Sorts"] = [{ Name: "apiKeyName", Order: order.toUpperCase() }];
  }
  if (opts["limit"] !== undefined) params["Limit"] = Number(opts["limit"]);
  if (opts["offset"] !== undefined) params["Offset"] = Number(opts["offset"]);

  const resp = await client.call("DescribeApiKeyList", params);
  const keys = (resp["ApiKeySet"] as ApiKey[] | undefined) ?? [];

  // 走脱敏版：响应里的 ApiKey 是明文，而文本模式这一列本来就是 mask 过的
  if (emitJsonSafe(resp)) return;

  printTable(
    ["NAME", "APIKEY_ID", "APIKEY", "PLATFORM", "STATUS", "CREATE_TIME"],
    keys.map((k) => [
      k.Name ?? "",
      k.ApiKeyId ?? "",
      mask(k.ApiKey),
      k.Platform ?? "",
      k.Status ?? "",
      k.CreateTime ?? "",
    ]),
  );
  console.log(summaryLine(resp["TotalCount"], keys.length, params["Offset"]));
}

/** get/reveal 共用的取单个密钥逻辑 */
async function fetchKey(
  client: Client,
  opts: Record<string, string>,
): Promise<ApiKey | undefined> {
  if (!opts["id"] && !opts["apiKey"]) {
    throw new Error(t("arg.needOneOf", { options: "--id, --api-key" }));
  }
  const params: Record<string, unknown> = { Platform: opts["platform"] ?? PLATFORM };
  if (opts["id"]) params["ApiKeyId"] = opts["id"];
  if (opts["apiKey"]) params["ApiKey"] = opts["apiKey"];
  const resp = await client.call("DescribeApiKey", params);
  return (resp["ApiKeyInfo"] ?? resp) as ApiKey | undefined;
}

async function getCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = buildClient(globals);
  const key = await fetchKey(client, opts);
  if (!key?.ApiKeyId) {
    if (emitJson(null)) return;
    console.log(t("key.notFound"));
    return;
  }

  if (emitJsonSafe(key)) return;

  const ips = key.IpWhitelist ?? [];
  const rows: Array<[string, string]> = [
    [t("key.label.id"), String(key.ApiKeyId ?? "")],
    [t("key.label.name"), key.Name ?? ""],
    [
      t("key.label.secret"),
      `${mask(key.ApiKey)}${t("key.revealHint", { id: key.ApiKeyId })}`,
    ],
    [t("key.label.platform"), key.Platform ?? ""],
    [t("key.label.uin"), `${key.Uin ?? "-"} / ${key.SubUin ?? "-"}`],
    [t("key.label.status"), key.Status ?? ""],
    [t("key.label.bindType"), key.BindType ?? ""],
    [t("key.label.editable"), key.Editable ? t("common.yes") : t("common.no")],
    [t("key.label.times"), `${key.CreateTime ?? "-"} / ${key.UpdateTime ?? "-"}`],
  ];
  if (key.Remark) {
    rows.push([t("key.label.remark"), key.Remark]);
  }
  rows.push([
    t("key.label.ipWhitelist"),
    ips.length ? ips.join(", ") : t("common.unlimited"),
  ]);

  const quotas = key.QuotaSet ?? [];
  if (!quotas.length) {
    rows.push([t("key.label.quota"), t("key.quotaNone")]);
  } else {
    const status =
      key.QuotaStatus === "inactive" ? t("key.quotaInactive") : (key.QuotaStatus ?? "-");
    rows.push([t("key.label.quota"), status]);
  }
  printAligned(rows);

  // 额度明细单独打，避免挤进两列表格
  for (const q of quotas) {
    const { text, exceeded } = quotaUsage(q);
    const code = t(`key.quotaStatus.${Number(q["Status"])}`);
    const codeText = code.startsWith("key.quotaStatus.") ? String(q["Status"] ?? "") : code;
    const flag = exceeded ? t("key.quotaExceeded") : "";
    console.log(`              ${text} ｜ ${codeText}${flag}`);
    console.log(
      `              ${t("key.quotaPeriod", { from: q["StartTime"] ?? "-", to: q["ExpireTime"] ?? "-" })}`,
    );
  }

  const bindings = key.BindingItems ?? [];
  if (bindings.length) {
    console.log("");
    printTable(
      ["RESOURCE_TYPE", "RESOURCE_ID", "STATUS"],
      bindings.map((b) => [
        String(b["ResourceType"] ?? ""),
        String(b["ResourceId"] ?? ""),
        String(b["Status"] ?? ""),
      ]),
    );
  }
}

async function revealCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const target = opts["id"] || opts["apiKey"];
  if (!target) {
    throw new Error(t("arg.needOneOf", { options: "--id, --api-key" }));
  }
  if (!(await confirm(t("key.reveal.confirm", { target }), Boolean(opts["yes"])))) {
    return;
  }
  const client = buildClient(globals);
  const key = await fetchKey(client, opts);
  if (!key?.ApiKey) {
    if (emitJson(null)) return;
    console.log(t("key.notFound"));
    return;
  }
  // 本命令是唯一允许输出明文的地方（用户显式索取且已过二次确认），故 JSON 模式
  // 也给明文——但只给这一个字段，不 dump 整个响应，避免顺带带出无关配置。
  if (emitJson({ ApiKeyId: key.ApiKeyId, ApiKey: key.ApiKey })) return;
  // 只打印明文本身，不带其它配置；调用日志从不记录响应体，明文不会落盘
  console.log(key.ApiKey);
}

async function createCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["name"]) {
    throw new Error(t("arg.missing", { command: "key create", args: "--name" }));
  }
  // 给了 --targets 就默认是 custom：不必再让用户把 --scope custom 也写一遍
  const scope = opts["scope"] ?? (opts["targets"] ? "custom" : undefined);
  if (!scope || !SCOPES.includes(scope)) {
    throw new Error(t("key.create.badScope"));
  }

  const targets = splitCsv(opts["targets"] ?? "");
  if (scope === "custom" && !targets.length) {
    throw new Error(t("key.create.needTargets"));
  }
  if (scope === "all" && targets.length) {
    throw new Error(t("key.create.allTakesNoTargets"));
  }

  const params: Record<string, unknown> = {
    Platform: opts["platform"] ?? PLATFORM,
    ApiKeyName: opts["name"],
    BindType: scope === "all" ? "all" : "model_custom_endpoint_custom",
  };
  if (targets.length) {
    params["Bindings"] = buildBindings(targets);
  }
  if (opts["remark"]) params["Remark"] = opts["remark"];
  if (opts["status"]) params["Status"] = opts["status"];
  if (opts["ipWhitelist"]) params["IpWhitelist"] = splitCsv(opts["ipWhitelist"]);
  if (opts["quotas"]) params["Quotas"] = parseJsonList("--quotas", opts["quotas"]);

  const client = buildClient(globals);
  const resp = await client.call("CreateApiKey", params);
  const keyId = resp["ApiKeyId"];
  // 脱敏：部分环境的 CreateApiKey 会在响应里带回新密钥明文
  if (emitJsonSafe(resp)) return;
  console.log(t("key.create.done", { id: keyId }));
  console.log(t("key.create.revealHint", { id: keyId }));
}

async function updateCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) {
    throw new Error(t("arg.missing", { command: "key update", args: "--id" }));
  }
  const params: Record<string, unknown> = {
    Platform: opts["platform"] ?? PLATFORM,
    ApiKeyId: opts["id"],
  };
  if (opts["name"]) params["ApiKeyName"] = opts["name"];
  if (opts["remark"] !== undefined) params["Remark"] = opts["remark"];
  // 传空串表示清空白名单，故用 !== undefined 而不是真值判断
  if (opts["ipWhitelist"] !== undefined) params["IpWhitelist"] = splitCsv(opts["ipWhitelist"]);

  if (Object.keys(params).length <= 2) {
    throw new Error(t("arg.needField", { command: "key update", fields: "--name/--remark/--ip-whitelist" }));
  }

  const client = buildClient(globals);
  const resp = await client.call("ModifyApiKeyInfo", params);
  if (emitJson({ ...resp, ApiKeyId: opts["id"] })) return;
  console.log(t("key.update.done", { id: opts["id"] }));
}

async function quotaCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) {
    throw new Error(t("arg.missing", { command: "key quota", args: "--id" }));
  }
  // quotasDesired 是 requiredOption，commander 已保证非空（?? "" 只为满足类型）。
  // JSON 结构写在 option 描述里（经真实调用校准：多传 PkgType 会 UnknownParameter，
  // CycleCredits 必须是字符串，写成数字会 InvalidParameter）
  const client = buildClient(globals);
  const resp = await client.call("ModifyApiKeyInfo", {
    Platform: opts["platform"] ?? PLATFORM,
    ApiKeyId: opts["id"],
    QuotasDesired: parseJsonList("--quotas-desired", opts["quotasDesired"] ?? ""),
  });
  if (emitJson({ ...resp, ApiKeyId: opts["id"] })) return;
  console.log(t("key.quota.done", { id: opts["id"] }));
}

/** enable/disable/status 共用；密钥泄露时要能立刻停用，故不做二次确认 */
async function statusCommand(
  verb: string,
  status: string,
  opts: Record<string, string>,
  globals: GlobalArgs,
): Promise<void> {
  if (!opts["id"]) {
    throw new Error(t("arg.missing", { command: `key ${verb}`, args: "--id" }));
  }
  if (!["enable", "disable"].includes(status)) {
    throw new Error(t("key.status.bad"));
  }
  const client = buildClient(globals);
  const resp = await client.call("ModifyApiKeyStatus", {
    Platform: opts["platform"] ?? PLATFORM,
    ApiKeyId: opts["id"],
    Status: status,
  });
  if (emitJson({ ...resp, ApiKeyId: opts["id"], Status: status })) return;
  console.log(t("key.status.done", { id: opts["id"], status }));
}

async function deleteCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) {
    throw new Error(t("arg.missing", { command: "key delete", args: "--id" }));
  }
  if (!(await confirm(t("key.delete.confirm", { id: opts["id"] }), Boolean(opts["yes"])))) {
    return;
  }
  const client = buildClient(globals);
  const resp = await client.call("DeleteApiKey", {
    Platform: opts["platform"] ?? PLATFORM,
    ApiKeyId: opts["id"],
  });
  if (emitJson({ ...resp, ApiKeyId: opts["id"], Deleted: true })) return;
  console.log(t("key.delete.done", { id: opts["id"] }));
}

/** 从 BindingItems 里取出资源 ID 清单，用于确认前后对比 */
function bindingIds(items: Array<Record<string, unknown>> | undefined): string[] {
  return (items ?? [])
    .map((b) => b["ResourceId"])
    .filter((id): id is string => typeof id === "string" && Boolean(id));
}

/**
 * 改已创建密钥的可访问范围。
 *
 * **这是全量覆盖**：传入的 Bindings 就是最终状态，原有绑定中未再次列出的会被
 * 解除，对应目标的线上调用立刻开始报鉴权失败。所以确认环节不能只问"改不改"——
 * 先查当前绑定，把"将被解除的目标"逐个列出来，用户才判断得准。
 */
async function scopeCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) {
    throw new Error(t("arg.missing", { command: "key scope", args: "--id" }));
  }
  // 与 key create 同一套写法：给了 --targets 就默认 custom，不必再写一遍 --scope
  const scope = opts["scope"] ?? (opts["targets"] ? "custom" : undefined);
  if (!scope || !SCOPES.includes(scope)) {
    throw new Error(t("key.scope.badScope", { options: SCOPES.join(" / ") }));
  }
  const targets = splitCsv(opts["targets"] ?? "");
  if (scope === "custom" && !targets.length) {
    throw new Error(t("key.create.needTargets"));
  }
  if (scope === "all" && targets.length) {
    throw new Error(t("key.create.allTakesNoTargets"));
  }

  const client = buildClient(globals);

  // 先读当前状态：确认提示要靠它算出"哪些目标会掉线"。
  // 必须走 fetchKey——响应把密钥包在 ApiKeyInfo 里，直接取顶层字段会全部读空，
  // 于是"将失去访问权"的清单算成空集、最关键的那条警告静默消失。
  const current = await fetchKey(client, opts);
  if (!current?.ApiKeyId) {
    console.log(t("key.notFound"));
    return;
  }
  const currentType = current.BindType ?? "";
  const currentIds = bindingIds(current.BindingItems);

  console.log(t("key.scope.header", { id: opts["id"] }));
  console.log(
    t("key.scope.currentLine", {
      scope: currentType === "all" ? "all" : "custom",
      detail: currentType === "all" ? t("key.scope.allDetail") : currentIds.join(", ") || "-",
    }),
  );
  console.log(
    t("key.scope.targetLine", {
      scope,
      detail: scope === "all" ? t("key.scope.allDetail") : targets.join(", "),
    }),
  );

  // 全量覆盖的实际后果：列出会被解除的目标。改成 all 是放宽权限，不会掉线
  const removed = scope === "all" ? [] : currentIds.filter((id) => !targets.includes(id));
  if (removed.length) {
    console.log("");
    console.log(t("key.scope.willRevoke", { targets: removed.join(", ") }));
  } else if (currentType === "all" && scope === "custom") {
    console.log("");
    console.log(t("key.scope.narrowFromAll"));
  }

  if (!(await confirm(t("key.scope.confirm", { id: opts["id"] }), Boolean(opts["yes"])))) {
    return;
  }

  const params: Record<string, unknown> = {
    Platform: opts["platform"] ?? PLATFORM,
    ApiKeyId: opts["id"],
    BindType: scope === "all" ? "all" : "model_custom_endpoint_custom",
  };
  if (targets.length) {
    params["Bindings"] = buildBindings(targets);
  }
  const resp = await client.call("ModifyApiKeyBindings", params);
  if (emitJson({ ...resp, ApiKeyId: opts["id"], BindType: params["BindType"] })) return;
  console.log(t("key.scope.done", { id: opts["id"] }));
}

/** 装配 key 命令组 */
export function registerKeyCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const key = program.command("key").description(t("group.key.desc"));

  key
    .command("list")
    .description(t("key.list.desc"))
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .option("--limit <n>", t("opt.limit"))
    .option("--offset <n>", t("opt.offset"))
    .option("--status <status>", t("key.opt.status"))
    .option("--id <id>", t("key.opt.id"))
    .option("--bind-type <type>", t("key.opt.bindType"))
    .option("--name <name>", t("key.opt.nameFilter"))
    .option("--order <order>", t("key.opt.order"))
    .action(async (opts) => listCommand(opts, getGlobals()));

  key
    .command("get")
    .description(t("key.get.desc"))
    .option("--id <id>", "ApiKeyId")
    .option("--api-key <key>", t("key.opt.apiKeyPlain"))
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .action(async (opts) => getCommand(opts, getGlobals()));

  key
    .command("reveal")
    .description(t("key.reveal.desc"))
    .option("--id <id>", "ApiKeyId")
    .option("--api-key <key>", t("key.opt.apiKeyPlain"))
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .option("--yes", t("opt.yes"))
    .action(async (opts) => revealCommand(opts, getGlobals()));

  key
    .command("create")
    .description(t("key.create.desc"))
    .requiredOption("--name <name>", t("key.create.opt.name"))
    .option("--scope <scope>", t("key.create.opt.scope"))
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .option("--remark <remark>", t("key.opt.remark"))
    .option("--status <status>", t("opt.initialStatus"), "enable")
    .option("--ip-whitelist <ips>", t("key.opt.ipWhitelist"))
    .option("--targets <ids>", t("key.create.opt.targets"))
    .option("--quotas <json>", t("key.opt.quotasJson"))
    .action(async (opts) => createCommand(opts, getGlobals()));

  key
    .command("update")
    .description(t("key.update.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .option("--name <name>", t("key.update.opt.name"))
    .option("--remark <remark>", t("key.update.opt.remark"))
    .option("--ip-whitelist <ips>", t("key.update.opt.ipWhitelist"))
    .action(async (opts) => updateCommand(opts, getGlobals()));

  key
    .command("quota")
    .description(t("key.quota.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .requiredOption("--quotas-desired <json>", t("key.opt.quotasJson"))
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .action(async (opts) => quotaCommand(opts, getGlobals()));

  key
    .command("enable")
    .description(t("key.enable.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .action(async (opts) => statusCommand("enable", "enable", opts, getGlobals()));

  key
    .command("disable")
    .description(t("key.disable.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .action(async (opts) => statusCommand("disable", "disable", opts, getGlobals()));

  key
    .command("status")
    .description(t("key.status.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .requiredOption("--status <status>", "enable | disable")
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .action(async (opts) => statusCommand("status", opts.status, opts, getGlobals()));

  key
    .command("delete")
    .description(t("key.delete.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .option("--yes", t("opt.yes"))
    .action(async (opts) => deleteCommand(opts, getGlobals()));

  key
    .command("scope")
    .description(t("key.scope.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--scope <scope>", t("key.create.opt.scope"))
    .option("--targets <ids>", t("key.create.opt.targets"))
    .option("--platform <platform>", t("opt.platform"), PLATFORM)
    .option("--yes", t("opt.yes"))
    .action(async (opts) => scopeCommand(opts, getGlobals()));
}
