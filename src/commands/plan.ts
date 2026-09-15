/**
 * plan 命令组：套餐（TokenPlan）与专属 Key。
 *
 * 专属 Key 用三级命令 `plan key <verb>`，与云 API 的资源层级对齐；不拍平成
 * `plan key-create` 那种两级形态。
 *
 * available/cost 对应的"可购套餐列表""下单前询价"云 API 没有接口，打印说明而不
 * 伪造调用。
 */
import { Command } from "commander";

import { buildClient, type Client } from "../core/client.js";
import { mask, type GlobalArgs } from "../core/credentials.js";
import { printAligned, printTable, summaryLine } from "../core/format.js";
import { formatPackageInfo, formatTokenSummary } from "../core/plan-format.js";
import { confirm } from "../core/prompt.js";
import { emitJson, emitJsonSafe } from "../core/output.js";
import { t } from "../core/i18n.js";
import { assertRfc3339, utcRangeMinutesAgo } from "../core/time.js";

/**
 * 可购买的套餐类型。与 ChargeType/BindType 不同，这份本地副本经实测与后端一致
 * （DescribeTokenPlanUserConfig 对非法值回显 "must be 'enterprise' or
 * 'enterprise-auto'"），且只有两个稳定值；留着能在查规格配置之前就挡住笔误
 */
const PRODUCT_TYPES = ["enterprise", "enterprise-auto"];

function autoRenewLabel(flag: unknown): string {
  if (flag === 1 || flag === true) return t("plan.autoRenew.on");
  if (flag === 0 || flag === false) return t("plan.autoRenew.off");
  return "-";
}

async function listCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = buildClient(globals);
  const params: Record<string, unknown> = {};
  if (opts["limit"] !== undefined) params["Limit"] = Number(opts["limit"]);
  if (opts["offset"] !== undefined) params["Offset"] = Number(opts["offset"]);

  const resp = await client.call("DescribeTokenPlanList", params);
  const plans = (resp["TokenPlanSet"] as Array<Record<string, unknown>> | undefined) ?? [];

  if (emitJson(resp)) return;

  printTable(
    ["TEAM_ID", "NAME", "PRODUCT_TYPE", "STATUS", "KEYS", "CREATED"],
    plans.map((p) => [
      String(p["TeamId"] ?? ""),
      String(p["Name"] ?? ""),
      String(p["ProductType"] ?? ""),
      String(p["Status"] ?? ""),
      `${p["ApiKeyCount"] ?? 0}/${p["ApiKeyMax"] ?? 0}`,
      String(p["CreatedAt"] ?? ""),
    ]),
  );
  console.log(summaryLine(resp["TotalCount"], plans.length, params["Offset"]));
}

/** 按 TeamId 取套餐详情。DescribeTokenPlan 把结果裹在 Team 里，兼容不裹的情况 */
async function fetchPlan(client: Client, teamId: string): Promise<Record<string, unknown>> {
  const resp = await client.call("DescribeTokenPlan", { TeamId: teamId });
  return (resp["Team"] ?? resp) as Record<string, unknown>;
}

async function infoCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) {
    throw new Error(t("plan.needTeamId"));
  }
  const client = buildClient(globals);
  const p = await fetchPlan(client, opts["teamId"]);

  if (emitJson(p)) return;

  printAligned([
    [t("plan.label.teamId"), String(p["TeamId"] ?? "")],
    [t("plan.label.name"), String(p["Name"] ?? "")],
    [t("plan.label.type"), String(p["ProductType"] ?? "")],
    [
      t("plan.label.status"),
      t("plan.statusValue", { status: p["Status"] ?? "", reason: p["StopReason"] || "-" }),
    ],
    [
      t("plan.label.keyCount"),
      t("plan.keyCountValue", { used: p["ApiKeyCount"] ?? 0, max: p["ApiKeyMax"] ?? 0 }),
    ],
    [t("plan.label.autoRenew"), autoRenewLabel(p["AutoRenewFlag"])],
    [t("plan.label.times"), `${p["CreatedAt"] ?? "-"} / ${p["UpdatedAt"] ?? "-"}`],
  ]);

  const productType = String(p["ProductType"] ?? "");
  const pkg = (p["PackageInfo"] ?? {}) as Record<string, unknown>;
  if (Object.keys(pkg).length) {
    console.log("");
    for (const line of formatPackageInfo(pkg, productType)) {
      console.log(line);
    }
  }
  const summary = (p["TokenSummary"] ?? {}) as Record<string, unknown>;
  if (Object.keys(summary).length) {
    console.log("");
    for (const line of formatTokenSummary(summary, productType)) {
      console.log(line);
    }
  }
}

async function modelsCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("plan.needTeamId"));
  const client = buildClient(globals);
  const p = await fetchPlan(client, opts["teamId"]);
  const pkg = (p["PackageInfo"] ?? {}) as Record<string, unknown>;
  const models = (pkg["AllowedModels"] ?? pkg["Models"]) as string[] | undefined;

  if (
    emitJson({
      TeamId: p["TeamId"],
      Name: p["Name"],
      ProductType: p["ProductType"],
      AllowedModels: models ?? [],
    })
  ) {
    return;
  }

  console.log(t("plan.models.header", { name: p["Name"] ?? "", type: p["ProductType"] ?? "" }));
  if (!models?.length) {
    console.log(`  ${t("plan.models.emptyNote")}`);
    return;
  }
  for (const m of models) {
    console.log(`  ${m}`);
  }
}

/**
 * 包住会真实扣款的调用（下单/续费/升配），失败时补一句"先查再重试"。
 *
 * 起因是实测踩到的真事：`plan buy` 返回 InternalError，但套餐**其实已经建成了**。
 * 若按错误提示直接重试就会买出第二个、扣两次钱，而套餐不可退。
 * 所以计费操作的失败不能等同于"没生效"——必须先查状态再决定。
 */
async function billingCall(
  run: () => Promise<void>,
  verifyHint: string,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n${t("plan.billing.mayHaveSucceeded", { verify: verifyHint })}`);
  }
}

/** DescribeTokenPlanUserConfig 返回的规格约束，随 productType 变 */
interface SpecConfig {
  EffectiveMin?: number;
  EffectiveMax?: number;
  ChargeStep?: number;
}

/**
 * 查某个 productType 的规格约束。
 *
 * 不把区间写死在 help 里：它是后端可调的运营参数（两个类型的下限差 500 倍），
 * 写死会过期；而且光靠"故意越界看报错"试不出 ChargeStep 这种约束。
 */
async function fetchSpecConfig(client: Client, productType: string): Promise<SpecConfig> {
  return (await client.call("DescribeTokenPlanUserConfig", {
    ProductType: productType,
  })) as SpecConfig;
}

/** 用真实配置本地校验规格，越界/不合步长直接拦下，不必等后端报错 */
function checkSpec(value: number, cfg: SpecConfig): void {
  const { EffectiveMin: min, EffectiveMax: max, ChargeStep: step } = cfg;
  if (min !== undefined && max !== undefined && (value < min || value > max)) {
    throw new Error(
      t("plan.buy.specRange", {
        value: value.toLocaleString(),
        min: min.toLocaleString(),
        max: max.toLocaleString(),
      }),
    );
  }
  if (step && value % step !== 0) {
    throw new Error(
      t("plan.buy.specStep", { value: value.toLocaleString(), step: step.toLocaleString() }),
    );
  }
}

async function buyCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const productType = opts["productType"];
  if (!productType || !PRODUCT_TYPES.includes(productType)) {
    throw new Error(t("plan.buy.needProductType"));
  }
  if (!opts["teamName"]) throw new Error(t("arg.missing", { command: "plan buy", args: "--team-name" }));
  if (opts["timeSpan"] === undefined || opts["creditOrToken"] === undefined) {
    throw new Error(t("plan.buy.needSpec"));
  }
  // 校验放在二次确认之前：别问完"确定购买吗"才告诉用户规格不合法
  const client = buildClient(globals);
  checkSpec(Number(opts["creditOrToken"]), await fetchSpecConfig(client, productType));

  // 购买与续订各用完整句子，不用动作词拼接——中英语序不同，拼接会让译文别扭
  const confirmKey = opts["teamId"] ? "plan.buy.confirmResubscribe" : "plan.buy.confirmBuy";
  const ok = await confirm(
    t(confirmKey, {
      name: opts["teamName"],
      productType,
      months: opts["timeSpan"],
      spec: opts["creditOrToken"],
    }),
    Boolean(opts["yes"]),
  );
  if (!ok) return;

  const params: Record<string, unknown> = {
    ProductType: productType,
    TeamName: opts["teamName"],
    TimeSpan: Number(opts["timeSpan"]),
    CreditOrToken: Number(opts["creditOrToken"]),
  };
  if (opts["autoRenew"]) params["EnableAutoRenew"] = true;
  if (opts["teamId"]) params["TeamId"] = opts["teamId"];

  await billingCall(async () => {
    const resp = await client.call("CreateTokenPlanTeamOrderAndBuy", params);
    if (emitJson(resp)) return;
    console.log(
      t("plan.buy.submitted", {
        id: resp["TeamId"] ?? resp["DealName"] ?? t("plan.buy.submittedOk"),
      }),
    );
  }, `thcli plan list --name ${opts["teamName"]}`);
}

async function renewCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("arg.missing", { command: "plan renew", args: "--team-id" }));
  if (opts["timeSpan"] === undefined) throw new Error(t("plan.renew.needMonths"));
  const ok = await confirm(
    t("plan.renew.confirm", { id: opts["teamId"], months: opts["timeSpan"] }),
    Boolean(opts["yes"]),
  );
  if (!ok) return;
  const client = buildClient(globals);
  await billingCall(async () => {
    const resp = await client.call("RenewTokenPlanTeamOrder", {
      TeamId: opts["teamId"],
      TimeSpan: Number(opts["timeSpan"]),
    });
    if (emitJson({ ...resp, TeamId: opts["teamId"], TimeSpan: opts["timeSpan"] })) return;
    console.log(t("plan.renew.submitted", { id: opts["teamId"], months: opts["timeSpan"] }));
  }, `thcli plan info --team-id ${opts["teamId"]}`);
}

async function upgradeCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("arg.missing", { command: "plan upgrade", args: "--team-id" }));
  if (opts["newCreditOrToken"] === undefined) {
    throw new Error(t("plan.upgrade.needSpec"));
  }
  const client = buildClient(globals);
  // upgrade 只收 TeamId，得先查出这个套餐的 productType 才知道该用哪套约束
  const plan = await fetchPlan(client, opts["teamId"]);
  const planType = String(plan?.["ProductType"] ?? "");
  if (planType) {
    checkSpec(Number(opts["newCreditOrToken"]), await fetchSpecConfig(client, planType));
  }

  const ok = await confirm(
    t("plan.upgrade.confirm", { id: opts["teamId"], spec: opts["newCreditOrToken"] }),
    Boolean(opts["yes"]),
  );
  if (!ok) return;
  await billingCall(async () => {
    const resp = await client.call("UpgradeTokenPlanTeamOrder", {
      TeamId: opts["teamId"],
      NewCreditOrToken: Number(opts["newCreditOrToken"]),
    });
    if (emitJson({ ...resp, TeamId: opts["teamId"], NewCreditOrToken: opts["newCreditOrToken"] })) return;
    console.log(t("plan.upgrade.submitted", { id: opts["teamId"], spec: opts["newCreditOrToken"] }));
  }, `thcli plan info --team-id ${opts["teamId"]}`);
}

/**
 * 用量明细的默认时间窗：最近 15 分钟，RFC3339 UTC（Z 结尾）。
 *
 * 客户端显式给出绝对时间，而不是留空由对端按自己的时钟兜底——两端各自取"现在"
 * 时，只要基准不完全一致，默认窗口就可能整体错开而查不到数据。带 Z 的绝对时间
 * 只有一种解释。窗口大小与原默认保持一致。
 */
function detailRange(opts: Record<string, string>): { start: string; end: string } {
  assertRfc3339(opts["from"], "--from");
  assertRfc3339(opts["to"], "--to");
  const fallback = utcRangeMinutesAgo(15);
  return { start: opts["from"] ?? fallback.start, end: opts["to"] ?? fallback.end };
}

/**
 * ApiKeyId 缩写成 `ak-tp-…59e0b5`。
 *
 * 完整 ID 有 47 字符，12 列平铺时它一列就吃掉四分之一行宽。保留前缀（看得出
 * Key 类型）和末 6 位（够在 `plan key list` 的输出里定位到唯一一把），中间省略。
 * 要完整 ID 用 --json——那里不缩写。
 */
function shortKeyId(id: unknown): string {
  const s = String(id ?? "");
  // 短于缩写后的长度就没必要动它
  if (s.length <= 20) return s;
  const prefix = s.slice(0, 6);
  return `${prefix}…${s.slice(-6)}`;
}

/**
 * 明细表的列定义，随 ProductType 变化——与控制台的两套表头对齐。
 *
 * enterprise（专业版）按积分计价，多出 4 个积分列，且 token 列序是
 * 输入/输出/缓存/总；其余（轻享版 enterprise-auto 等）不计积分，token 列序是
 * 输入/缓存/输出/总。**两者的 token 列序确实不同**，这是控制台的真实差异，
 * 不是笔误，改成统一顺序会与控制台对不上。
 */
function detailColumns(productType: string): Array<{ header: string; field: string }> {
  const head = [
    { header: "REQUEST_TIME", field: "RequestTime" },
    { header: "REQUEST_ID", field: "RequestId" },
    { header: "MODEL", field: "ModelName" },
    { header: "APIKEY_NAME", field: "ApiKeyName" },
    { header: "APIKEY_ID", field: "ApiKeyId" },
  ];
  if (productType === "enterprise") {
    return [
      ...head,
      { header: "IN_TOK", field: "InputToken" },
      { header: "OUT_TOK", field: "OutputToken" },
      { header: "CACHE_TOK", field: "CacheToken" },
      { header: "TOTAL_TOK", field: "TotalToken" },
      { header: "IN_CR_MISS", field: "InputCredits" },
      { header: "IN_CR_HIT", field: "CacheCredits" },
      { header: "OUT_CR", field: "OutputCredits" },
      { header: "TOTAL_CR", field: "TotalCredits" },
    ];
  }
  return [
    ...head,
    { header: "IN_TOK", field: "InputToken" },
    { header: "CACHE_TOK", field: "CacheToken" },
    { header: "OUT_TOK", field: "OutputToken" },
    { header: "TOTAL_TOK", field: "TotalToken" },
  ];
}

async function detailCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("arg.missing", { command: "plan detail", args: "--team-id" }));
  const range = detailRange(opts);
  const params: Record<string, unknown> = { TeamId: opts["teamId"] };
  if (opts["id"]) params["ApiKeyId"] = opts["id"];
  if (opts["name"]) params["ApiKeyName"] = opts["name"];
  if (opts["modelName"]) params["ModelName"] = opts["modelName"];
  // 字段名是 From/To，不是别处那套 StartTime/EndTime——本接口与 usage 系列不同源
  params["From"] = range.start;
  params["To"] = range.end;
  if (opts["sort"]) params["Sort"] = opts["sort"];
  if (opts["limit"] !== undefined) params["Limit"] = Number(opts["limit"]);
  // 翻页游标：上一次响应的 Context 原样回传。翻页时 From/To/Sort/Limit 等
  // 筛选条件必须与上一次完全一致，游标只在同一组条件下有意义。
  if (opts["context"]) params["Context"] = opts["context"];

  const client = buildClient(globals);
  const resp = await client.call("DescribeTokenPlanApiKeyUsageDetail", params);
  // 明细数组的键是 List，不是 usage 系列那套 XxxSet——本接口与 usage 不同源（同 From/To）
  const rows = (resp["List"] as Array<Record<string, unknown>> | undefined) ?? [];

  if (emitJson(resp)) return;

  // 列集合随 ProductType 走。响应顶层给了 ProductType，不需要用户传参。
  const columns = detailColumns(String(resp["ProductType"] ?? ""));

  // RequestTime 服务端给的是 UTC（Z 结尾），原样展示：明细常用于跟服务端日志、
  // RequestId 对账，转本地时区反而要求对账双方各自换算回去。
  printTable(
    columns.map((c) => c.header),
    rows.map((r) =>
      columns.map((c) => (c.field === "ApiKeyId" ? shortKeyId(r[c.field]) : String(r[c.field] ?? ""))),
    ),
  );
  // 还有下一页：把游标原样给出。不自动续拉——明细量可能很大，翻页由用户决定。
  if (resp["ListOver"] === false) {
    const cursor = resp["Context"];
    console.log(t("plan.detail.more", { count: rows.length }));
    if (typeof cursor === "string" && cursor !== "") {
      console.log(t("plan.detail.nextPage", { context: cursor }));
    }
  }
}

// ------------------------------------------------------------- 专属 Key 动词

async function keyListCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("arg.missing", { command: "plan key list", args: "--team-id" }));
  const params: Record<string, unknown> = { TeamId: opts["teamId"] };
  if (opts["limit"] !== undefined) params["Limit"] = Number(opts["limit"]);
  if (opts["offset"] !== undefined) params["Offset"] = Number(opts["offset"]);

  const client = buildClient(globals);
  const resp = await client.call("DescribeTokenPlanApiKeyList", params);
  const keys = (resp["ApiKeySet"] as Array<Record<string, unknown>> | undefined) ?? [];

  // 响应里带密钥明文，与文本模式一致地打码
  if (emitJsonSafe(resp)) return;

  printTable(
    ["APIKEY_ID", "NAME", "APIKEY", "STATUS", "USE", "CREATED"],
    keys.map((k) => [
      String(k["ApiKeyId"] ?? ""),
      String(k["Name"] ?? ""),
      mask(k["ApiKey"] as string),
      String(k["Status"] ?? ""),
      String(k["UseStatus"] ?? ""),
      String(k["CreatedAt"] ?? ""),
    ]),
  );
  console.log(summaryLine(resp["TotalCount"], keys.length, params["Offset"]));
}

async function keyCreateCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["teamId"]) throw new Error(t("arg.missing", { command: "plan key create", args: "--team-id" }));
  if (!opts["name"]) throw new Error(t("arg.missing", { command: "plan key create", args: "--name" }));
  if (opts["count"] === undefined) throw new Error(t("plan.key.create.needCount"));

  const params: Record<string, unknown> = {
    TeamId: opts["teamId"],
    ApiKeyName: opts["name"],
    Count: Number(opts["count"]),
  };
  if (opts["allowedModels"]) params["AllowedModels"] = opts["allowedModels"];
  if (opts["exclusiveQuota"] !== undefined) params["ExclusiveQuota"] = Number(opts["exclusiveQuota"]);
  if (opts["totalQuota"] !== undefined) params["TotalQuota"] = Number(opts["totalQuota"]);
  if (opts["tpm"] !== undefined) params["TPM"] = Number(opts["tpm"]);

  const client = buildClient(globals);
  const resp = await client.call("CreateTokenPlanApiKeys", params);
  // 接口返回 Items[{ApiKeyId, SubPkgId}]，不是 ApiKeyIds 字符串数组——曾按后者解析，
  // 于是创建成功却一行不打印，用户以为失败会重复执行（真建出多把 Key）
  const items = (resp["Items"] as Array<Record<string, unknown>> | undefined) ?? [];
  const failed = (resp["FailedItems"] as unknown[] | undefined) ?? [];

  if (emitJsonSafe(resp)) return;

  if (items.length) {
    console.log(t("plan.key.create.created", { count: items.length }));
    for (const item of items) {
      const id = String(item["ApiKeyId"] ?? "");
      const sub = item["SubPkgId"] ? `  (SubPkgId=${String(item["SubPkgId"])})` : "";
      console.log(`  ${id}${sub}`);
    }
    console.log(t("plan.key.create.revealHint"));
  }
  if (failed.length) {
    console.log(t("plan.key.create.failed", { count: failed.length }));
    for (const f of failed) console.log(`  ${JSON.stringify(f)}`);
  }
  // 两个都空说明响应结构又变了——静默返回会让人再次误判成失败
  if (!items.length && !failed.length) {
    console.log(t("plan.key.create.unexpected", { body: JSON.stringify(resp) }));
  }
}

async function keyGetCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "plan key get", args: "--id" }));
  const client = buildClient(globals);
  const resp = await client.call("DescribeTokenPlanApiKey", { ApiKeyId: opts["id"] });
  const k = (resp["ApiKey"] ?? resp) as Record<string, unknown>;

  if (emitJsonSafe(k)) return;

  const rows: Array<[string, string]> = [
    ["Key ID", String(k["ApiKeyId"] ?? "")],
    [t("plan.key.label.name"), String(k["Name"] ?? "")],
    [
      t("plan.key.label.secret"),
      `${mask(k["ApiKey"] as string)}${t("plan.key.revealHint", { id: k["ApiKeyId"] })}`,
    ],
    [t("plan.key.label.teamId"), String(k["TeamId"] ?? "")],
    [
      t("plan.key.label.status"),
      t("plan.key.statusValue", { status: k["Status"] ?? "", useStatus: k["UseStatus"] ?? "" }),
    ],
    [t("plan.key.label.models"), String(k["AllowedModels"] || "-")],
  ];
  if (k["Balance"]) {
    rows.push([t("plan.key.label.balance"), JSON.stringify(k["Balance"])]);
  }
  printAligned(rows);
}

async function keyRevealCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "plan key reveal", args: "--id" }));
  if (!(await confirm(t("plan.key.reveal.confirm", { id: opts["id"] }), Boolean(opts["yes"])))) {
    return;
  }
  const client = buildClient(globals);
  const resp = await client.call("DescribeTokenPlanApiKeySecret", { ApiKeyId: opts["id"] });
  const secret = resp["ApiKey"] ?? resp["Secret"];
  if (!secret) {
    if (emitJson(null)) return;
    console.log(t("plan.key.reveal.empty"));
    return;
  }
  // 与 key reveal 同理：本命令就是来取明文的（已过二次确认），故 JSON 也给明文，
  // 但只给这一个字段、不 dump 整个响应
  if (emitJson({ ApiKeyId: opts["id"], ApiKey: String(secret) })) return;
  console.log(String(secret));
}

async function keyUpdateCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "plan key update", args: "--id" }));
  const params: Record<string, unknown> = { ApiKeyId: opts["id"] };
  if (opts["allowedModels"]) params["AllowedModels"] = opts["allowedModels"];
  if (opts["exclusiveQuota"] !== undefined) params["ExclusiveQuota"] = Number(opts["exclusiveQuota"]);
  if (opts["totalQuota"] !== undefined) params["TotalQuota"] = Number(opts["totalQuota"]);
  if (opts["tpm"] !== undefined) params["TPM"] = Number(opts["tpm"]);
  if (opts["status"]) {
    if (!["enable", "disable"].includes(opts["status"])) {
      throw new Error(t("plan.key.badStatus"));
    }
    params["UseStatus"] = opts["status"];
  }
  if (Object.keys(params).length <= 1) {
    throw new Error(
      t("arg.needField", {
        command: "plan key update",
        fields: "--allowed-models/--exclusive-quota/--total-quota/--status/--tpm",
      }),
    );
  }

  const client = buildClient(globals);
  const resp = await client.call("ModifyTokenPlanApiKey", params);
  if (emitJson({ ...resp, ApiKeyId: opts["id"] })) return;
  console.log(t("plan.key.update.done", { id: opts["id"] }));
}

async function keyRotateCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "plan key rotate", args: "--id" }));
  const ok = await confirm(
    t("plan.key.rotate.confirm", { id: opts["id"] }),
    Boolean(opts["yes"]),
  );
  if (!ok) return;
  const client = buildClient(globals);
  const resp = await client.call("ModifyTokenPlanApiKeySecret", { ApiKeyId: opts["id"] });
  if (emitJsonSafe({ ...resp, ApiKeyId: opts["id"] })) return;
  console.log(t("plan.key.rotate.done", { id: opts["id"] }));
}

async function keyDeleteCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (!opts["id"]) throw new Error(t("arg.missing", { command: "plan key delete", args: "--id" }));
  const ok = await confirm(
    t("plan.key.delete.confirm", { id: opts["id"] }),
    Boolean(opts["yes"]),
  );
  if (!ok) return;
  const client = buildClient(globals);
  const resp = await client.call("DeleteTokenPlanApiKey", { ApiKeyId: opts["id"] });
  if (emitJson({ ...resp, ApiKeyId: opts["id"], Deleted: true })) return;
  console.log(t("plan.key.delete.done", { id: opts["id"] }));
}

/** 装配 plan 命令组 */
export function registerPlanCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const plan = program.command("plan").description(t("group.plan.desc"));

  plan
    .command("list")
    .description(t("plan.list.desc"))
    .option("--limit <n>", t("opt.limit"))
    .option("--offset <n>", t("opt.offset"))
    .action(async (opts) => listCommand(opts, getGlobals()));

  plan
    .command("info")
    .description(t("plan.info.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .action(async (opts) => infoCommand(opts, getGlobals()));

  plan
    .command("models")
    .description(t("plan.models.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .action(async (opts) => modelsCommand(opts, getGlobals()));

  plan
    .command("buy")
    .description(t("plan.buy.desc"))
    .requiredOption("--product-type <type>", "enterprise | enterprise-auto")
    .requiredOption("--team-name <name>", t("plan.buy.opt.teamName"))
    .requiredOption("--time-span <months>", t("plan.buy.opt.timeSpan"))
    .requiredOption("--credit-or-token <n>", t("plan.buy.opt.creditOrToken"))
    .option("--auto-renew", t("plan.buy.opt.autoRenew"))
    .option("--team-id <id>", t("plan.buy.opt.teamId"))
    .option("--yes", t("opt.yes"))
    .action(async (opts) => buyCommand(opts, getGlobals()));

  plan
    .command("renew")
    .description(t("plan.renew.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .requiredOption("--time-span <months>", t("plan.renew.opt.timeSpan"))
    .option("--yes", t("opt.yes"))
    .action(async (opts) => renewCommand(opts, getGlobals()));

  plan
    .command("upgrade")
    .description(t("plan.upgrade.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .requiredOption("--new-credit-or-token <n>", t("plan.upgrade.opt.newCreditOrToken"))
    .option("--yes", t("opt.yes"))
    .action(async (opts) => upgradeCommand(opts, getGlobals()));

  plan
    .command("detail")
    .description(t("plan.detail.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .option("--id <id>", t("plan.detail.opt.id"))
    .option("--name <name>", t("plan.detail.opt.name"))
    .option("--model-name <name>", t("plan.detail.opt.modelName"))
    .option("--from <time>", t("plan.detail.opt.from"))
    .option("--to <time>", t("plan.detail.opt.to"))
    .option("--sort <sort>", t("plan.detail.opt.sort"))
    .option("--limit <n>", t("opt.limit"))
    .option("--context <cursor>", t("plan.detail.opt.context"))
    .action(async (opts) => detailCommand(opts, getGlobals()));

  plan
    .command("available")
    .description(t("plan.available.desc"))
    .action(() => {
      console.log(t("plan.available.unsupported"));
      console.log(t("plan.available.consoleHint"));
      console.log("  https://console.cloud.tencent.com/tokenhub");
      console.log(t("plan.available.thenBuy"));
    });

  plan
    .command("cost")
    .description(t("plan.cost.desc"))
    .action(() => {
      console.log(
        t("plan.cost.unsupported"),
      );
      console.log(t("plan.cost.consoleHint"));
    });

  // 三级命令：plan key <verb>
  const key = plan.command("key").description(t("plan.key.desc"));

  key
    .command("list")
    .description(t("plan.key.list.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .option("--limit <n>", t("opt.limit"))
    .option("--offset <n>", t("opt.offset"))
    .action(async (opts) => keyListCommand(opts, getGlobals()));

  key
    .command("create")
    .description(t("plan.key.create.desc"))
    .requiredOption("--team-id <id>", t("opt.teamId"))
    .requiredOption("--name <name>", t("plan.key.create.opt.name"))
    .requiredOption("--count <n>", t("plan.key.create.opt.count"))
    .option("--allowed-models <models>", t("plan.key.opt.allowedModelsCsv"))
    .option("--exclusive-quota <n>", t("plan.key.opt.exclusiveQuota"))
    .option("--total-quota <n>", t("plan.key.opt.totalQuota"))
    .option("--tpm <n>", t("opt.tpm"))
    .action(async (opts) => keyCreateCommand(opts, getGlobals()));

  key
    .command("get")
    .description(t("plan.key.get.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .action(async (opts) => keyGetCommand(opts, getGlobals()));

  key
    .command("reveal")
    .description(t("plan.key.reveal.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--yes", t("opt.yes"))
    .action(async (opts) => keyRevealCommand(opts, getGlobals()));

  key
    .command("update")
    .description(t("plan.key.update.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--allowed-models <models>", t("plan.key.opt.allowedModels"))
    .option("--exclusive-quota <n>", t("plan.key.opt.exclusiveQuota"))
    .option("--total-quota <n>", t("plan.key.opt.totalQuota"))
    .option("--status <status>", "enable | disable")
    .option("--tpm <n>", t("opt.tpm"))
    .action(async (opts) => keyUpdateCommand(opts, getGlobals()));

  key
    .command("rotate")
    .description(t("plan.key.rotate.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--yes", t("opt.yes"))
    .action(async (opts) => keyRotateCommand(opts, getGlobals()));

  key
    .command("delete")
    .description(t("plan.key.delete.desc"))
    .requiredOption("--id <id>", "ApiKeyId")
    .option("--yes", t("opt.yes"))
    .action(async (opts) => keyDeleteCommand(opts, getGlobals()));
}
