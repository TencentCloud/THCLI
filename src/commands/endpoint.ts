/**
 * endpoint 命令组（推理服务/接入点）+ 顶层 deploy（创建）。
 *
 * DescribeModelEndpointList 的 Filters 官方只声明了 Status/ChargeType/RequestSource/
 * ModelName/ModelId/PaymentEnabled，但实测 EndpointId（精确）/EndpointName（模糊）
 * 同样能被后端正确过滤——本地 api.json 声明滞后于真实后端能力。
 *
 * 注意 ModelName 与 ModelId 是两个不同字段（ModelId 可能是英文全称，ModelName 是
 * 缩写），--model-name 过滤的是 ModelName。
 */
import { Command } from "commander";

import { buildClient, type Client } from "../core/client.js";
import type { GlobalArgs } from "../core/credentials.js";
import { printAligned, printTable, splitCsv, stopReasonAdvice, summaryLine } from "../core/format.js";
import { emitJson } from "../core/output.js";
import { t } from "../core/i18n.js";
import { confirm } from "../core/prompt.js";

/** --order-by 简写 → 真实排序字段 */
const SORT_FIELD: Record<string, string> = { created: "CreatedTime", updated: "UpdatedTime" };

interface Endpoint {
  EndpointId?: string;
  EndpointName?: string;
  ModelId?: string;
  ModelName?: string;
  Status?: string;
  ChargeType?: string;
  PaymentEnabled?: boolean;
  StopReason?: string;
  ChargeDetail?: string;
}

/** 免费额度信息藏在 ChargeDetail 这个 JSON 字符串里 */
function parseFreeQuota(chargeDetail: string | undefined): Record<string, unknown> | undefined {
  if (!chargeDetail) return undefined;
  try {
    const parsed = JSON.parse(chargeDetail) as Record<string, unknown>;
    return (parsed["FreeQuota"] as Record<string, unknown> | undefined) ?? undefined;
  } catch {
    // 后端返回的不是合法 JSON 时静默跳过，不影响主体信息展示
    return undefined;
  }
}

async function listCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = buildClient(globals);
  const params: Record<string, unknown> = {};
  const filters: Array<Record<string, unknown>> = [];

  if (opts["id"]) filters.push({ Name: "EndpointId", Op: "EXACT", Values: [opts["id"]] });
  if (opts["endpointName"])
    filters.push({ Name: "EndpointName", Op: "FUZZY", Values: [opts["endpointName"]] });
  if (opts["status"]) filters.push({ Name: "Status", Op: "EXACT", Values: [opts["status"]] });
  if (opts["chargeType"])
    filters.push({ Name: "ChargeType", Op: "EXACT", Values: [opts["chargeType"]] });
  if (opts["requestSource"])
    filters.push({ Name: "RequestSource", Op: "EXACT", Values: [opts["requestSource"]] });
  if (opts["modelId"]) filters.push({ Name: "ModelId", Op: "EXACT", Values: [opts["modelId"]] });
  if (opts["modelName"])
    filters.push({ Name: "ModelName", Op: "FUZZY", Values: [opts["modelName"]] });
  if (opts["paymentEnabled"] !== undefined)
    filters.push({
      Name: "PaymentEnabled",
      Op: "EXACT",
      Values: [String(opts["paymentEnabled"]).toLowerCase()],
    });
  if (filters.length) params["Filters"] = filters;

  if (opts["orderBy"]) {
    const field = SORT_FIELD[opts["orderBy"].toLowerCase()];
    if (!field) throw new Error(t("endpoint.badOrderBy"));
    const order = (opts["order"] ?? "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") throw new Error(t("arg.badOrder"));
    params["Sorts"] = [{ Name: field, Order: order.toUpperCase() }];
  }
  if (opts["limit"] !== undefined) params["Limit"] = Number(opts["limit"]);
  if (opts["offset"] !== undefined) params["Offset"] = Number(opts["offset"]);

  const resp = await client.call("DescribeModelEndpointList", params);
  const endpoints = (resp["ModelEndpointSet"] as Endpoint[] | undefined) ?? [];

  if (emitJson(resp)) return;

  printTable(
    ["ENDPOINT_ID", "MODEL_ID", "MODEL_NAME", "STATUS", "CHARGE", "PAYMENT"],
    endpoints.map((e) => [
      e.EndpointId ?? "",
      e.ModelId ?? "",
      e.ModelName ?? "",
      e.Status ?? "",
      e.ChargeType ?? "",
      e.PaymentEnabled ? "on" : "off",
    ]),
  );
  console.log(summaryLine(resp["TotalCount"], endpoints.length, params["Offset"]));
}

async function getCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "endpoint get", args: "--id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeEndpoint", { EndpointId: opts["id"] });
  const e = (resp["Endpoint"] ?? resp) as Endpoint;

  if (emitJson(e)) return;

  const rows: Array<[string, string]> = [
    [t("endpoint.label.service"), `${e.EndpointName ?? ""} (${e.EndpointId ?? ""})`],
    [t("endpoint.label.model"), `${e.ModelName ?? ""} (${e.ModelId ?? ""})`],
    [t("endpoint.label.status"), e.Status ?? ""],
    [t("endpoint.label.chargeType"), e.ChargeType || "-"],
    [t("endpoint.label.postpaid"), e.PaymentEnabled ? t("common.enabled") : t("common.disabled")],
  ];
  if (e.StopReason) {
    const advice = stopReasonAdvice(e.StopReason, e.EndpointId);
    rows.push([t("endpoint.label.stopReason"), `${e.StopReason}${advice ? ` —— ${advice}` : ""}`]);
  }
  const free = parseFreeQuota(e.ChargeDetail);
  if (free) {
    const used = Number(free["UsedQuota"] ?? 0);
    const total = Number(free["TotalQuota"] ?? 0);
    const percent = total > 0 ? ((used / total) * 100).toFixed(1) : "0.0";
    rows.push([
      t("endpoint.label.freeQuota"),
      t("endpoint.freeQuotaValue", { used, total, percent }),
    ]);
  }
  printAligned(rows);
}

/** ModelType → CreateEndpoint 的 ServiceType。实测这两个枚举一一对应，5 类全覆盖 */
const SERVICE_TYPE_BY_MODEL_TYPE: Record<string, string> = {
  Text: "TEXT_GENERATION",
  Vision: "VISION",
  Multimodal: "MULTIMODAL",
  Embedding: "EMBEDDING",
  Speech: "SPEECH",
};

/** 按模型的 ModelType 推出 ServiceType；推不出来时让后端去判定 */
async function resolveServiceType(client: Client, modelId: string): Promise<string | undefined> {
  const resp = await client.call("DescribeModelList", { ModelIds: [modelId] });
  const model = ((resp["ModelSet"] as Array<Record<string, unknown>> | undefined) ?? [])[0];
  if (!model) {
    throw new Error(t("deploy.modelNotFound", { id: modelId }));
  }
  return SERVICE_TYPE_BY_MODEL_TYPE[String(model["ModelType"] ?? "")];
}

async function deployCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["modelId"]) {
    throw new Error(t("deploy.needModel"));
  }
  if (!opts["name"]) {
    throw new Error(t("deploy.needName"));
  }
  // ChargeType 不做本地校验：后端拒绝时会回显完整合法值列表，比 CLI 维护一份必然
  // 过期的副本可靠。曾写死 ["FREE","TOKEN","TPM","COMPUTE_UNIT"]，实测后端认的是
  // [NONE FREE TPM_PRE TPM_POST TPM_RESERVE TOKEN COUNT CREDIT PICTURE]——TPM 和
  // COMPUTE_UNIT 根本不存在，还漏了 5 个
  const client = buildClient(globals);

  // ServiceType 后端必填，但它完全由模型决定（实测传错的会被后端按模型纠正回去：
  // 给文本模型 hy3 传 SPEECH，建出来仍是 TEXT_GENERATION）。既然是可推导的，就别
  // 让用户填——多一个必填参数只会多一处填错的机会
  const serviceType = opts["serviceType"] ?? (await resolveServiceType(client, opts["modelId"]));

  const params: Record<string, unknown> = {
    EndpointName: opts["name"],
    ModelId: opts["modelId"],
    ChargeType: opts["chargeType"],
    ServiceType: serviceType,
  };
  if (opts["rpm"] !== undefined) params["RPM"] = Number(opts["rpm"]);
  if (opts["tpm"] !== undefined) params["TPM"] = Number(opts["tpm"]);
  if (opts["endpointId"]) params["EndpointId"] = opts["endpointId"];
  if (opts["autoAdjustQuota"] !== undefined)
    params["AutoAdjustQuota"] = Number(opts["autoAdjustQuota"]);

  const resp = await client.call("CreateEndpoint", params);
  if (emitJson(resp)) return;
  console.log(t("deploy.done", { id: resp["EndpointId"] }));
  if (resp["StopReason"]) {
    console.log(t("deploy.initialState", { reason: resp["StopReason"] }));
  }
}

/**
 * endpoint update：改推理服务的配置（限流、名称、计费方式、自动调额）。
 *
 * ModifyEndpoint 支持 6 个字段，这里全部暴露。把「改配」与「调限流」
 * 列成两条命令（对应控制台两个入口），但底层是同一个 Action——拆成
 * endpoint update / endpoint limit 只会让用户纠结该用哪个，故合并在此。
 * Status 不在其中：接口不接受该参数（实测报 not recognized），服务启停走
 * endpoint postpaid。
 */
async function updateCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "endpoint update", args: "--id" }));

  const params: Record<string, unknown> = { EndpointId: opts["id"] };

  // 三个限流值后端要求正整数：实测 -1 和 0 都报 "must be greater than 0"，
  // 小数报 "should be int64"。只挡这两条，不猜上限——上限由后端按 AutoAdjustQuota
  // 托管（传超大值不报错，会被系统调回实际配额）
  //
  // 这里保留本地校验、不像 ChargeType/BindType 那样交给后端：正整数是稳定的数学
  // 约束，不是会随运营调整的取值表，且能把「-1 打错成 1」在发请求前说清楚
  for (const [flag, field] of [
    ["rpm", "RPM"],
    ["tpm", "TPM"],
    ["qpm", "QPM"],
  ] as const) {
    const raw = opts[flag];
    if (raw === undefined) {
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(t("endpoint.update.badNumber", { flag: `--${flag}`, value: raw }));
    }
    params[field] = value;
  }

  if (opts["autoAdjustQuota"] !== undefined) {
    params["AutoAdjustQuota"] = Number(opts["autoAdjustQuota"]);
  }
  if (opts["name"]) {
    params["EndpointName"] = opts["name"];
  }
  // 计费方式不做本地枚举校验：实际取值含组合形式（FREE,TOKEN）与 CREDIT/PICTURE/NONE，
  // 比文档里的四个枚举多，写死清单会挡住合法输入。交给后端判定
  if (opts["chargeType"]) {
    params["ChargeType"] = opts["chargeType"];
  }

  if (Object.keys(params).length <= 1) {
    throw new Error(
      t("endpoint.update.needField", {
        fields: "--rpm/--tpm/--qpm/--name/--charge-type/--auto-adjust-quota",
      }),
    );
  }

  const client = buildClient(globals);
  const resp = await client.call("ModifyEndpoint", params);
  if (emitJson({ ...resp, EndpointId: opts["id"] })) return;
  console.log(t("endpoint.update.done", { id: opts["id"] }));
}

async function deleteCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "endpoint delete", args: "--id" }));
  const ok = await confirm(
    t("endpoint.delete.confirm", { id: opts["id"] }),
    Boolean(opts["yes"]),
  );
  if (!ok) return;
  const client = buildClient(globals);
  const resp = await client.call("DeleteEndpoint", { EndpointId: opts["id"] });
  if (emitJson({ ...resp, EndpointId: opts["id"], Deleted: true })) return;
  console.log(t("endpoint.delete.done", { id: opts["id"] }));
}

/**
 * endpoint postpaid on|off：开关推理服务的后付费。
 *
 * 两个方向语义不同：
 *   on   开启后付费，并顺带领取该服务尚未领取的免费包
 *   off  关闭后付费，已领取的免费包不受影响
 *
 * 走 ModifyPaymentState(EndpointId, PaymentEnabled) 而非按模型批量的那个接口——
 * 同一模型可以有多个端点且各自状态不同（实测 minimax-m3 有两个端点都停了，
 * 但同模型另一些端点是正常的），按模型操作会波及不该动的端点。
 */
async function postpaidCommand(
  state: string | undefined,
  opts: { endpoint?: string; all?: boolean; yes?: boolean; dryRun?: boolean },
  globals: GlobalArgs,
): Promise<void> {
  const normalized = String(state ?? "").toLowerCase();
  if (normalized !== "on" && normalized !== "off") {
    console.log(t("endpoint.postpaid.needState"));
    console.log(t("endpoint.postpaid.scopeHint"));
    return;
  }
  const enable = normalized === "on";

  const client = buildClient(globals);
  let targets: Array<{ id: string; label: string }>;

  if (opts.endpoint) {
    targets = splitCsv(opts.endpoint).map((id) => ({ id, label: id }));
  } else if (opts.all) {
    // --all：按当前方向取全部待处理的端点
    console.log(t("endpoint.postpaid.scanningAll"));
    const list = await fetchAllEndpoints(client);
    targets = list
      .filter((e) => e.EndpointId && e.PaymentEnabled !== enable)
      .map((e) => ({ id: e.EndpointId as string, label: `${e.ModelId ?? "-"}（${e.EndpointId}）` }));
  } else if (enable) {
    // 不指定范围时只自动挑「因免费额度用尽而停止」的：其它停止原因（欠费、
    // 无免费包）开后付费也恢复不了，扫进来只会产生无效调用
    console.log(t("endpoint.postpaid.scanning"));
    const list = await fetchAllEndpoints(client);
    targets = list
      .filter((e) => e.StopReason === "FREE_QUOTA_EXHAUSTED" && e.EndpointId)
      .map((e) => ({ id: e.EndpointId as string, label: `${e.ModelId ?? "-"}（${e.EndpointId}）` }));
  } else {
    // off 方向不隐式批量：一次关掉所有服务的后付费破坏性太大，必须显式
    // --endpoint 点名或 --all 表态
    console.log(t("endpoint.postpaid.offNeedScope"));
    return;
  }

  if (!targets.length) {
    console.log(t("endpoint.postpaid.nothing"));
    return;
  }

  // 名单可能很长（--all 时可达上百个），折叠避免铺满整屏
  const labels = targets.map((x) => x.label);
  const names =
    labels.length <= 6
      ? labels.join(", ")
      : t("common.andMore", { head: labels.slice(0, 6).join(", "), count: labels.length });
  console.log(
    enable
      ? t("endpoint.postpaid.plan", { count: targets.length, names })
      : t("endpoint.postpaid.offPlan", { count: targets.length, names }),
  );
  console.log(enable ? t("endpoint.postpaid.onNote") : t("endpoint.postpaid.offNote"));

  if (opts.dryRun) {
    console.log(t("billing.dryRun"));
    return;
  }
  if (!(await confirm(t("billing.confirmPrompt"), opts.yes))) {
    console.log(t("billing.aborted"));
    return;
  }

  // 逐个调用：单个端点失败不该让整批中断，且能逐条报原因
  const failures: Array<{ model: string; reason: string }> = [];
  for (const target of targets) {
    try {
      await client.call("ModifyPaymentState", {
        EndpointId: target.id,
        PaymentEnabled: enable,
      });
    } catch (err) {
      failures.push({ model: target.label, reason: (err as Error).message });
    }
  }

  const ok = targets.length - failures.length;

  // 逐个端点操作、可能部分失败，故结构里带上成败明细
  if (
    emitJson({
      PaymentEnabled: enable,
      Requested: targets.length,
      Succeeded: ok,
      Failures: failures,
    })
  ) {
    return;
  }

  if (failures.length) {
    console.log(t("models.free.partial", { ok, failed: failures.length }));
    for (const f of failures) {
      console.log(t("models.free.itemFail", f));
    }
  } else {
    console.log(
      enable ? t("endpoint.postpaid.ok", { count: ok }) : t("endpoint.postpaid.offOk", { count: ok }),
    );
  }
  if (enable && ok > 0) {
    console.log(t("endpoint.postpaid.verify"));
  }
}

/** 分页拉全量端点（接口上限 Limit=99） */
async function fetchAllEndpoints(client: ReturnType<typeof buildClient>): Promise<Endpoint[]> {
  const out: Endpoint[] = [];
  for (let offset = 0; ; offset += 99) {
    const resp = await client.call("DescribeModelEndpointList", { Limit: 99, Offset: offset });
    const page = (resp["ModelEndpointSet"] as Endpoint[] | undefined) ?? [];
    out.push(...page);
    const total = Number(resp["TotalCount"] ?? out.length);
    if (page.length < 99 || out.length >= total) {
      break;
    }
  }
  return out;
}

/** 装配 endpoint 命令组与顶层 deploy */
export function registerEndpointCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const endpoint = program.command("endpoint").description(t("group.endpoint.desc"));

  endpoint
    .command("list")
    .description(t("endpoint.list.desc"))
    .option("--id <id>", t("endpoint.opt.id"))
    .option("--endpoint-name <name>", t("endpoint.opt.name"))
    .option("--status <status>", t("endpoint.opt.status"))
    .option("--charge-type <type>", t("endpoint.opt.chargeType"))
    .option("--request-source <source>", t("endpoint.opt.requestSource"))
    .option("--model-id <id>", t("endpoint.opt.modelId"))
    .option("--model-name <name>", t("endpoint.opt.modelName"))
    .option("--payment-enabled <bool>", t("endpoint.opt.paymentEnabled"))
    .option("--order-by <field>", t("endpoint.opt.orderBy"))
    .option("--order <order>", t("opt.orderDir"), "desc")
    .option("--limit <n>", t("opt.limit"))
    .option("--offset <n>", t("opt.offset"))
    .action(async (opts) => listCommand(opts, getGlobals()));

  endpoint
    .command("postpaid")
    .description(t("endpoint.postpaid.desc"))
    .argument("<state>", t("endpoint.postpaid.argState"))
    .option("--endpoint <ids>", t("endpoint.postpaid.scopeHint"))
    .option("--all", t("endpoint.postpaid.allHint"))
    .option("--yes", t("opt.yes"))
    .option("--dry-run", t("opt.dryRun"))
    .action(
      async (
        state: string | undefined,
        opts: { endpoint?: string; all?: boolean; yes?: boolean; dryRun?: boolean },
      ) => postpaidCommand(state, opts, getGlobals()),
    );

  endpoint
    .command("get")
    .description(t("endpoint.get.desc"))
    .requiredOption("--id <id>", "EndpointId")
    .action(async (opts) => getCommand(opts, getGlobals()));

  endpoint
    .command("update")
    .description(t("endpoint.update.desc"))
    .requiredOption("--id <id>", "EndpointId")
    .option("--rpm <n>", t("endpoint.opt.rpm"))
    .option("--tpm <n>", t("endpoint.opt.tpm"))
    .option("--qpm <n>", t("endpoint.opt.qpm"))
    .option("--name <name>", t("endpoint.opt.rename"))
    .option("--charge-type <type>", t("endpoint.opt.chargeTypeSet"))
    .option("--auto-adjust-quota <n>", t("endpoint.opt.autoAdjustQuota"))
    .action(async (opts) => updateCommand(opts, getGlobals()));

  endpoint
    .command("delete")
    .description(t("endpoint.delete.desc"))
    .requiredOption("--id <id>", "EndpointId")
    .option("--yes", t("opt.yes"))
    .action(async (opts) => deleteCommand(opts, getGlobals()));

  program
    .command("deploy")
    .description(t("group.deploy.desc"))
    .requiredOption("--model-id <id>", "ModelId")
    .requiredOption("--name <name>", t("deploy.opt.name"))
    .requiredOption("--charge-type <type>", t("deploy.opt.chargeType"))
    .option("--service-type <type>", t("deploy.opt.serviceType"))
    .option("--rpm <n>", t("opt.rpm"))
    .option("--tpm <n>", t("opt.tpm"))
    .option("--endpoint-id <id>", t("deploy.opt.endpointId"))
    .option("--auto-adjust-quota <n>", t("endpoint.opt.autoAdjustQuota"))
    .action(async (opts) => deployCommand(opts, getGlobals()));
}
