/**
 * 套餐额度与用量的渲染。
 *
 * 后端把套餐额度拆成多个层次，直接打 JSON 用户看不懂，这里翻译成人话：
 *   PackageInfo   套餐整体：总额度 / 已用 / 周期数 / 本周期额度
 *   TokenSummary  本周期明细：BillingItems 按计费项（input/output/cache）拆分实际消耗
 *
 * 两个关键坑：
 * 1. **两者单位不同**。PackageInfo 的额度按套餐类型计价：enterprise（专业版）
 *    用 credits（积分）、enterprise-auto（轻享版）用 tokens；而 BillingItems.TotalQty
 *    永远是 tokens。所以专业版会出现「已用 2.58 积分」与「本周期 3015 tokens」
 *    并存——不是数据矛盾，是两个量纲，必须分别标注单位，绝不能混排成同一个数。
 * 2. BillingItems 为空数组是正常的——表示本周期还没产生过调用，不是查询出错。
 */
import { human } from "./format.js";
import { t } from "./i18n.js";

/** 计费项 key → 显示名。未收录的原样回显，不猜 */
function billingItemName(key: string): string {
  const label = t(`billing.item.${key}`);
  return label.startsWith("billing.item.") ? key : label;
}

/** 周期单位 → 显示名。未收录的原样回显 */
function cycleUnitName(code: string): string {
  const label = t(`plan.cycle.${code}`);
  return label.startsWith("plan.cycle.") ? code : label;
}

/**
 * 套餐额度的计价单位。专业版（enterprise）按积分，轻享版（enterprise-auto）按 token。
 * 判断依据是官方 api.json 对 TotalQuota/TotalUsed 的单位说明。
 */
function quotaUnit(productType: string): string {
  return productType === "enterprise" ? t("plan.unit.credit") : t("plan.unit.token");
}

function fmtTime(value: unknown): string {
  const text = String(value ?? "");
  // 2026-07-26T16:01:54+08:00 → 2026-07-26 16:01
  return text.length >= 16 ? `${text.slice(0, 10)} ${text.slice(11, 16)}` : text || "-";
}

/**
 * 渲染套餐额度概览（PackageInfo）。返回逐行文本，调用方决定缩进。
 * productType 决定额度单位，必须传入。
 */
export function formatPackageInfo(
  pkg: Record<string, unknown>,
  productType: string,
): string[] {
  if (!Object.keys(pkg).length) {
    return [t("plan.quota.none")];
  }
  const unit = quotaUnit(productType);
  const lines: string[] = [];

  const total = Number(pkg["TotalQuota"] ?? pkg["TotalCredits"] ?? 0);
  const used = Number(pkg["TotalUsed"] ?? 0);
  const percent = total > 0 ? ((used / total) * 100).toFixed(2) : "-";
  lines.push(
    t("plan.quota.totalLine", { used: human(used), total: human(total), unit, percent }),
  );

  const cycleTotal = Number(pkg["CycleQuota"] ?? pkg["CycleCredits"] ?? 0);
  if (cycleTotal > 0) {
    const cycle = cycleUnitName(String(pkg["CycleUnit"] ?? ""));
    lines.push(
      t("plan.quota.cycleLine", {
        total: human(cycleTotal),
        unit,
        cycle,
        current: pkg["CurrentCycle"] ?? "-",
        totalCycles: pkg["TotalCycles"] ?? "-",
        remain: pkg["RemainCycles"] ?? "-",
      }),
    );
  }

  // 专属池与共享池：只在真的分配了才显示，否则是噪音
  const exclusive = Number(pkg["ExclusiveAllocated"] ?? 0);
  if (exclusive > 0) {
    lines.push(
      t("plan.quota.exclusiveLine", {
        used: human(Number(pkg["ExclusiveUsed"] ?? 0)),
        total: human(exclusive),
        unit,
      }),
    );
  }
  const shared = Number(pkg["SharedPool"] ?? 0);
  if (shared > 0) {
    lines.push(
      t("plan.quota.sharedLine", {
        used: human(Number(pkg["SharedUsed"] ?? 0)),
        total: human(shared),
        unit,
      }),
    );
  }

  lines.push(
    t("plan.quota.validLine", { from: fmtTime(pkg["StartTime"]), to: fmtTime(pkg["ExpireTime"]) }),
  );
  return lines;
}

/**
 * 渲染本周期用量明细（TokenSummary）。这里的量永远是 tokens，与上面的额度单位
 * 可能不同，故独立标注。
 */
export function formatTokenSummary(
  summary: Record<string, unknown>,
  productType: string,
): string[] {
  if (!Object.keys(summary).length) {
    return [t("plan.usage.none")];
  }
  const lines: string[] = [];
  lines.push(
    t("plan.usage.cycleLineFull", {
      seq: summary["CycleSeq"] ?? "-",
      from: fmtTime(summary["CycleStartTime"]),
      to: fmtTime(summary["CycleEndTime"]),
    }),
  );

  const items = (summary["BillingItems"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (!items.length) {
    // 空数组是正常状态，明确说明避免用户以为查询出错
    lines.push(t("plan.usage.zero"));
    return lines;
  }

  // call_count 是次数不是 token，不能并入 token 合计
  const tokenItems = items.filter((i) => String(i["BillingItem"]) !== "call_count");
  const total = tokenItems.reduce((sum, i) => sum + Number(i["TotalQty"] ?? 0), 0);

  // 专业版的额度按积分计，这里的 token 数与上面的积分不是一回事，加注说明
  const note = quotaUnit(productType) === t("plan.unit.token") ? "" : t("plan.usage.creditNote");
  lines.push(t("plan.usage.totalLine", { total: human(total), note }));
  for (const item of items) {
    const key = String(item["BillingItem"] ?? "");
    const name = billingItemName(key);
    const qty = Number(item["TotalQty"] ?? 0).toLocaleString();
    lines.push(
      t("plan.usage.itemLine", {
        name,
        qty,
        suffix: key === "call_count" ? t("plan.usage.callSuffix") : "",
      }),
    );
  }
  return lines;
}
