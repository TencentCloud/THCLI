/**
 * usage 命令组：用量排行（终端图表）与导出（CSV）。
 *
 * 响应结构（真实接口验证）：
 *   MetricKeys  本次返回了哪些指标，如 [TotalToken, InputTotalToken, ...]
 *   Timestamps  时间轴（epoch 秒），与每个 Series 数组按下标一一对应
 *   TopList[]   排行项，各含 Rank/Key/Name/Stats（汇总）/Series（各指标的时序数组，
 *               无数据的点是 null）
 *   TotalStats  全量汇总；PageStats 当前页汇总
 *
 * 接口一次回 10 条。rank 默认就展示这一页（--offset 翻页、--show-all 取全量），
 * 但**必须显式标注范围**：图表与排行榜只覆盖本页，而 TotalStats 是全量的，
 * 量级能差几千倍（实测 --offset 10 时图表峰值 81.77K 而全量 434.60M）。
 * 故分页时标题写明第几名到第几名，底部并列「本页 / 全部」两栏。
 *
 * 另注意 ShowAll=true 时后端不返回 Series（实测首项 Series=undefined），
 * 故 --show-all 下没有时序图，只有排行表。
 */
import fs from "node:fs";
import { Command } from "commander";

import { buildClient } from "../core/client.js";
import type { GlobalArgs } from "../core/credentials.js";
import {
  displayWidth,
  human,
  pad,
  sparkline,
  stackedChart,
  type StackSeries,
  verticalChart,
} from "../core/format.js";
import { colorEnabled, SERIES_CAPACITY, seriesColor, seriesGlyph } from "../core/color.js";
import { emitJson, isJson } from "../core/output.js";
import { lang, t } from "../core/i18n.js";
import { assertRfc3339 } from "../core/time.js";
import {
  buildMonitorClient,
  metricLabel,
  warmMetricLabels,
  DEFAULT_METRIC_KEYS,
  DIMENSION_KEYS,
  METRICS,
  metricByKey,
  type MetricSeries,
} from "../core/monitor.js";

/** 可选的统计维度 */
// 保留本地副本：实测后端也认这三个（非法值回显 "must be one of apikey/endpoint/model"），
// 但这里同时要给 --dimension 兜默认值 model，本地已有这份语义
const DIMENSIONS = ["apikey", "endpoint", "model"];

/** 接口要求 Period 必填，默认按小时聚合 */
const DEFAULT_PERIOD = 3600;

/** 排行项。Series 的各指标值后端返回的是 JSON 字符串而非真数组，故类型放宽 */
interface TopItem {
  Rank?: number;
  Key?: string;
  Name?: string;
  Stats?: Record<string, number>;
  Series?: Record<string, unknown>;
}

/** 把 Series 里的一项归一成数组：后端返回的是 "[1,null,2]" 这样的 JSON 字符串 */
function toSeriesArray(value: unknown): Array<number | null> {
  if (Array.isArray(value)) {
    return value as Array<number | null>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as Array<number | null>) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function defaultTimeRange(): { start: string; end: string } {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const fmt = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;
  return { start: fmt(dayAgo), end: fmt(now) };
}

/**
 * 转成监控接口要的 ISO8601 带偏移格式（2026-08-23T00:00:00+08:00）。
 * 管控面接口用的是 Z 结尾的 UTC，两者不通用，故这里显式转一次。
 */
function toOffsetIso(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(t("time.badFormat", { value }));
  }
  const p = (n: number): string => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

function buildParams(opts: Record<string, string>): Record<string, unknown> {
  const dimension = opts["dimension"] ?? "model";
  if (!DIMENSIONS.includes(dimension)) {
    throw new Error(t("usage.badDimension"));
  }
  const range = defaultTimeRange();
  assertRfc3339(opts["startTime"], "--start-time");
  assertRfc3339(opts["endTime"], "--end-time");
  const params: Record<string, unknown> = {
    Dimension: dimension,
    StartTime: opts["startTime"] ?? range.start,
    EndTime: opts["endTime"] ?? range.end,
    MetricType: opts["metricType"] ?? "tokens",
    Period: opts["period"] === undefined ? DEFAULT_PERIOD : Number(opts["period"]),
  };
  if (opts["target"]) params["Target"] = opts["target"];
  if (opts["offset"] !== undefined) params["Offset"] = Number(opts["offset"]);
  return params;
}


/**
 * 排行接口的指标简称。与云监控的指标名不同源——那套走元数据取双语名
 * （见 core/monitor.ts 的 metricLabel），这套是排行接口特有的，故单列。
 * 未收录的 key 原样回显，不猜。
 */
function rankMetricLabel(key: string): string {
  const label = t(`rankMetric.${key}`);
  return label === `rankMetric.${key}` ? key : label;
}

/** epoch 秒 → 本地时间标签。用本地时区，UTC 会让用户对不上自己的作息 */
function timeLabel(ts: number, period: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  // 粒度 ≥ 1 天时不显示时分，否则全是 00:00 占位没意义
  return period >= 86400
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}


/**
 * 默认视图：堆叠柱状图 + 图例。
 *
 * 既看总量走势，又看构成——哪个模型在哪个时段吃掉了配额，一眼可辨。
 * 超过配色容量的对象合并成「其它 N 个」，而不是默默丢弃：丢弃会让柱高
 * 与底部汇总对不上。
 */
function renderStacked(
  topList: TopItem[],
  timestamps: number[],
  metric: string,
  period: number,
  offset: number,
  total: number,
): void {
  // 只给前 N 个具名系列——配色数量有限，再多就分辨不出颜色了
  const named = topList.slice(0, SERIES_CAPACITY);
  const rest = topList.slice(SERIES_CAPACITY);

  const series: StackSeries[] = named.map((item) => ({
    name: item.Name ?? item.Key ?? "-",
    values: toSeriesArray(item.Series?.[metric]),
    total: item.Stats?.[metric] ?? 0,
  }));

  if (rest.length) {
    const merged = timestamps.map((_, i) =>
      rest.reduce((sum, item) => sum + (toSeriesArray(item.Series?.[metric])[i] ?? 0), 0),
    );
    series.push({
      name: t("usage.rank.restGroup", { count: rest.length }),
      values: merged,
      total: rest.reduce((sum, item) => sum + (item.Stats?.[metric] ?? 0), 0),
      isRest: true,
    });
  }

  const chart = stackedChart(
    series,
    (i) => axisLabel(timestamps[i] ?? 0, period),
    (v) => human(v),
    (index, isRest) => seriesGlyph(index, isRest),
    (index, text, isRest) => seriesColor(index, text, isRest),
  );

  // 标题按实际渲染方式表述：无颜色时是靠字符区分，说"分色"就不准确了
  const how = colorEnabled ? t("usage.rank.howColor") : t("usage.rank.howGlyph");
  console.log(t("usage.rank.seriesTitle", { metric: rankMetricLabel(metric), how }));
  for (const row of chart.rows) {
    console.log(row);
  }
  console.log(chart.axis);
  console.log(chart.labels);
  console.log("");

  // 图例即排行榜：色块 + 排名 + 名称 + 汇总，不必再单列一份排行表
  const shown = series.reduce((sum, item) => sum + item.total, 0);
  for (const [index, item] of series.entries()) {
    const isRest = item.isRest === true;
    const swatch = seriesColor(index, seriesGlyph(index, isRest), isRest);
    const no = isRest ? " —" : String(offset + index + 1).padStart(2, "0");
    console.log(`  ${swatch} ${no}  ${pad(item.name, 38)} ${human(item.total).padStart(10)}`);
  }

  // 图上只有当前这一页的对象，而底部汇总是全量的——必须说清差在哪，
  // 否则「图里 10 个加起来 468.9M」与「全部合计 469.28M」看着像同一个范围
  const covered = offset + series.filter((it) => it.isRest !== true).length;
  if (total > covered) {
    console.log(
      `  ${t("usage.rank.scopeNote", {
        from: offset + 1,
        to: covered,
        total,
        shown: human(shown),
        next: covered,
      })}`,
    );
  }
  console.log("");
}

/** 这批对象里有没有可画的时序数据 */
function hasAnySeries(topList: TopItem[], metric: string): boolean {
  return topList.some((item) =>
    toSeriesArray(item.Series?.[metric]).some((v) => typeof v === "number"),
  );
}

/**
 * 默认视图：每个对象一张独立卡片，与 usage trend 的呈现一致。
 *
 * 为什么平铺而非「每对象一行 sparkline」：各行共用峰值基准时，量级悬殊的对象
 * 整行都是最低格（实测榜首 161M、末位 7 token，19/21 行全是 ▁），走势完全看不见。
 * 每张卡片按自身峰值缩放，小对象的波形也清楚；代价是纵向更长，故默认只出一页。
 */
function renderCards(
  topList: TopItem[],
  timestamps: number[],
  metric: string,
  period: number,
  startRank: number,
): void {
  for (const [index, item] of topList.entries()) {
    const name = item.Name ?? item.Key ?? "-";
    const total = item.Stats?.[metric] ?? 0;
    const series = toSeriesArray(item.Series?.[metric]);

    console.log(
      t("usage.rank.cardTitle", {
        rank: String(startRank + index).padStart(2, "0"),
        name,
        total: human(total),
      }),
    );

    const present = series.filter((v): v is number => typeof v === "number" && v > 0);
    if (!present.length) {
      console.log(`    ${t("usage.rank.cardNoData")}`);
      console.log("");
      continue;
    }

    const chart = verticalChart(
      series,
      (i) => axisLabel(timestamps[i] ?? 0, period),
      (v) => human(v),
    );
    for (const row of chart.rows) {
      console.log(row);
    }
    console.log(chart.axis);
    console.log(chart.labels);

    const max = Math.max(...present);
    const min = Math.min(...present);
    const avg = present.reduce((sum, v) => sum + v, 0) / present.length;
    const peakIndex = series.findIndex((v) => v === max);
    const peakAt = timestamps[peakIndex];
    const peakNote =
    peakAt === undefined ? "" : t("chart.peakAt", { when: timeLabel(peakAt, period) });
    console.log(
      `  ${t("chart.stats", {
        max: pad(human(max), 10),
        peak: peakNote,
        min: pad(human(min), 10),
        avg: human(avg),
      })}`,
    );
    console.log("");
  }
}

/** 占比条宽度：够看出量级差异，又不挤走时间轴 */
const SHARE_BAR_WIDTH = 12;

/**
 * 全量排行总表：先给全貌，再往下看详细走势卡片。
 *
 * 数据来自 ShowAll=true 的那次请求——它返回全部对象但**不带 Series**，正好适合
 * 做总表（只需汇总值）。走势图那份数据由分页请求提供。
 */
function renderOverview(
  topList: TopItem[],
  metric: string,
  detailFrom: number,
  detailCount: number,
): void {
  const rows = topList.map((item) => ({
    name: item.Name ?? item.Key ?? "-",
    total: item.Stats?.[metric] ?? 0,
  }));
  if (!rows.length) {
    return;
  }
  const nameWidth = Math.min(34, Math.max(16, ...rows.map((r) => displayWidth(r.name))));
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  console.log(t("usage.rank.overviewHeader", { count: rows.length }));
  for (const [index, row] of rows.entries()) {
    const cells = Math.max(
      row.total > 0 ? 1 : 0,
      Math.round((row.total / maxTotal) * SHARE_BAR_WIDTH),
    );
    const bar = "▇".repeat(cells) + " ".repeat(SHARE_BAR_WIDTH - cells);
    // 占比用全量合计做分母，回答"它吃掉了多少比例"
    const share = grandTotal > 0 ? ((row.total / grandTotal) * 100).toFixed(1) : "0.0";
    // 下方有详细卡片的那几名标个记号，便于对照。翻页时标的是当前那一页，
    // 不是固定的前 N 名——否则 --offset 10 时记号会指向没有卡片的对象
    const hasDetail = index >= detailFrom && index < detailFrom + detailCount ? "▾" : " ";
    console.log(
      `  ${String(index + 1).padStart(2, "0")}${hasDetail} ${pad(row.name, nameWidth)} ${bar} ` +
        `${human(row.total).padStart(10)} ${share.padStart(5)}%`,
    );
  }
  console.log("");
}

async function rankCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = buildClient(globals);
  const params = buildParams(opts);

  // 两次并发请求（实测合计 ~309ms）：
  //   ShowAll=true  拿全部对象做总表，但它不返回 Series，画不了走势
  //   分页请求      拿本页 10 个的 Series，用于详细走势卡片
  // 一次请求拿不到"全量 + 时序"，这是接口决定的，故并发取两份。
  const [overviewResp, resp] = await Promise.all([
    client.call("DescribeUsageRankList", { ...params, ShowAll: true, Offset: 0 }),
    client.call("DescribeUsageRankList", params),
  ]);
  const overviewList = (overviewResp["TopList"] as TopItem[] | undefined) ?? [];
  const topList = (resp["TopList"] as TopItem[] | undefined) ?? [];
  const timestamps = (resp["Timestamps"] as number[] | undefined) ?? [];
  const metricKeys = (resp["MetricKeys"] as string[] | undefined) ?? [];
  const totalStats = (resp["TotalStats"] as Record<string, number> | undefined) ?? {};
  const pageStats = resp["PageStats"] as Record<string, number> | undefined;
  const total = Number(resp["Total"] ?? topList.length);
  const offset = Number(params["Offset"] ?? 0);
  // 第一个指标即主指标（tokens 下是 TotalToken，search 下是搜索次数）
  const primary = metricKeys[0] ?? "TotalToken";
  // 分页时图表与排行榜只覆盖本页，与全量汇总不是一个范围——必须显式说明
  const paged = !opts["showAll"] && total > topList.length;

  // 图表只是这些数据的可视化，底层本来就是结构化的。两个响应都给出来：
  // Overview 是全量排行（无时序），TopList/Timestamps 是本页的时序明细。
  if (
    emitJson({
      Dimension: params["Dimension"],
      MetricType: params["MetricType"],
      StartTime: params["StartTime"],
      EndTime: params["EndTime"],
      Total: total,
      Offset: offset,
      MetricKeys: metricKeys,
      TotalStats: totalStats,
      PageStats: pageStats,
      Overview: overviewList,
      TopList: topList,
      Timestamps: timestamps,
    })
  ) {
    return;
  }

  console.log(
    t("usage.rank.title", {
      dimension: params["Dimension"],
      metricType: params["MetricType"],
      from: params["StartTime"],
      to: params["EndTime"],
    }),
  );
  console.log("");

  // 先总表给全貌（▾ 标出下方有详细走势的那几名），再平铺卡片。
  // --color 模式跳过：那个图的图例本身就是带色块的完整排行，再来一张表纯重复。
  if (!opts["color"]) {
    renderOverview(overviewList, primary, offset, topList.length);
  }

  const period = Number(params["Period"]) || DEFAULT_PERIOD;

  if (!topList.length) {
    console.log(t("usage.rank.empty"));
    console.log("");
  } else if (!timestamps.length || !hasAnySeries(topList, primary)) {
    console.log(t("usage.rank.noSeries"));
    console.log("");
  } else if (opts["color"]) {
    // 堆叠分色图：一屏看完构成，但依赖终端色彩能力，故不做默认
    renderStacked(topList, timestamps, primary, period, offset, total);
  } else {
    // 默认：每个对象一张卡片平铺，与 usage trend 的呈现一致
    console.log(
      t("usage.rank.detailTitle", {
        from: offset + 1,
        to: offset + topList.length,
        more:
          total > offset + topList.length
            ? t("usage.rank.detailMore", { next: offset + topList.length })
            : "",
      }),
    );
    console.log("");
    renderCards(topList, timestamps, primary, period, offset + 1);
    if (colorEnabled) {
      console.log(t("usage.rank.colorHint"));
      console.log("");
    }
  }



  // 汇总始终是全量的（总表也是全量），范围一致，不必再分栏
  console.log(t("usage.rank.totalsHeader"));
  for (const key of metricKeys) {
    console.log(`  ${pad(rankMetricLabel(key), 12)}: ${human(totalStats[key] ?? 0)}`);
  }
}

/** X 轴的短时间标签：小时粒度只给时:分，天粒度给月-日 */
function axisLabel(ts: number, period: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return period >= 86400
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 画一个指标的卡片：标题 + 纵向柱状图（带 Y 轴刻度）+ 最大/最小/平均，
 * 对齐控制台「用量趋势」页的每指标一张图。null 是该时间点无数据（与 0 不同，控制台按断点处理），
 * 统计时排除，否则平均值会被拉低。
 */
function renderMetricCard(series: MetricSeries, period: number): void {
  const { meta, timestamps, values } = series;
  const named = metricLabel(meta);
  // 括号随语言走：英文界面里全角「（）」很扎眼
  console.log(lang() === "en" ? `${named.label} (${named.unit})` : `${named.label}（${named.unit}）`);
  if (!timestamps.length) {
    console.log(`  ${t("chart.noData")}`);
    console.log("");
    return;
  }

  const present = values.filter((v): v is number => typeof v === "number");
  if (!present.length) {
    console.log(`  ${t("chart.noData")}`);
    console.log("");
    return;
  }
  const max = Math.max(...present);
  const min = Math.min(...present);
  const avg = present.reduce((sum, v) => sum + v, 0) / present.length;
  const peakIndex = values.findIndex((v) => v === max);
  const peakAt = timestamps[peakIndex];

  // X 轴用短标签（只时:分或月-日）——完整日期已在下方的区间说明里，
  // 轴上重复完整日期会挤掉大部分刻度
  const chart = verticalChart(values, (i) => axisLabel(timestamps[i] ?? 0, period), (v) => human(v));
  for (const row of chart.rows) {
    console.log(row);
  }
  console.log(chart.axis);
  console.log(chart.labels);

  console.log(
    `  ${t("chart.range", {
      from: timeLabel(timestamps[0] ?? 0, period),
      to: timeLabel(timestamps[timestamps.length - 1] ?? 0, period),
    })}`,
  );
  const peakNote =
    peakAt === undefined ? "" : t("chart.peakAt", { when: timeLabel(peakAt, period) });
  console.log(
    `  ${t("chart.stats", {
      max: pad(human(max), 10),
      peak: peakNote,
      min: pad(human(min), 10),
      avg: human(avg),
    })}`,
  );
  console.log("");
}

/**
 * 若该模型是非文本模型（图片/视频/音频/3D），返回提示语；否则返回空。
 *
 * 这些模型不产生 token，用 token 指标查必然是空图。宁可多一次查询也要给出准确
 * 指引——"无数据"和"用错了命令"对用户是完全不同的结论。
 * 查询失败不阻断主流程（best-effort），只是拿不到提示而已。
 */
async function aigcModelHint(globals: GlobalArgs, model: string): Promise<string | undefined> {
  try {
    const resp = await buildClient(globals).call("DescribeAIGCModelList", {});
    const list = (resp["ModelList"] as Array<{ ModelID?: string; ModelType?: string }>) ?? [];
    const hit = list.find((m) => m.ModelID === model);
    if (!hit) {
      return undefined;
    }
    return (
      `${t("usage.trend.visionModel", { model, type: hit.ModelType ?? "-" })}\n` +
      t("usage.trend.visionUse", { model })
    );
  } catch {
    return undefined;
  }
}

/**
 * usage trend：账号整体的用量走势，走云监控（Barad）接口。
 *
 * 与 usage rank 是不同的数据源，各有各的强项：
 *   rank  DescribeUsageRankList  能按 model/apikey/endpoint 拆对象，指标只有 4 个
 *   trend GetMonitorData         指标 14 个（TPM/缓存读写/平均 token），但只有账号级
 * 所以 trend 不提供 --dimension/--target——监控指标的维度只有 uin，给了也无法生效。
 */
async function trendCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const period = opts["period"] === undefined ? DEFAULT_PERIOD : Number(opts["period"]);
  const range = defaultTimeRange();

  // 下钻维度：任一给了值就只看那个对象，都不给则是账号整体（全部模型/端点/密钥合计）
  const filters: Record<string, string> = {};
  for (const key of DIMENSION_KEYS) {
    const value = opts[key];
    if (value) {
      filters[key] = String(value);
    }
  }

  const query = {
    // 监控接口要 ISO8601 带时区偏移，与管控面的 Z 结尾格式不同
    startTime: toOffsetIso(opts["startTime"] ?? range.start),
    endTime: toOffsetIso(opts["endTime"] ?? range.end),
    period,
    filters,
  };

  // --metric 可多次传或逗号分隔；不传则用缺省核心指标
  const requested = opts["metric"]
    ? String(opts["metric"])
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_METRIC_KEYS;
  const metrics = opts["all"] ? METRICS : requested.map(metricByKey);

  // 指定了模型时先确认它是不是文本模型：非文本模型不产生 token，这里查出来全是
  // 空图，用户会误判"没有用量"，实际是该用 monitor vision
  if (filters["model"]) {
    const hint = await aigcModelHint(globals, filters["model"]);
    if (hint) {
      console.log(hint);
      return;
    }
  }

  const client = await buildMonitorClient(globals);
  const scope = Object.entries(filters)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  // JSON 模式不能先打标题——那会让 stdout 变成「一行人话 + 一段 JSON」，解析直接失败。
  // 故标题与提示都放在 isJson 之外，数据取完再统一决定输出形态。
  if (!isJson()) {
    console.log(
      t("usage.trend.title", {
        uin: client.uin,
        scope: scope || t("scope.allObjects"),
        from: query.startTime,
        to: query.endTime,
        period,
      }),
    );
    console.log("");
  }

  // 监控接口「仅支持单指标拉取」，故每个指标一次请求。并发发出，不逐个串行等。
  const results = await Promise.all(metrics.map((meta) => client.fetch(meta, query)));

  if (
    emitJson({
      Uin: client.uin,
      Scope: filters,
      StartTime: query.startTime,
      EndTime: query.endTime,
      Period: period,
      Series: results.map((s) => ({
        MetricKey: s.meta.key,
        MetricName: s.meta.name,
        Unit: s.meta.unit,
        Timestamps: s.timestamps,
        Values: s.values,
      })),
    })
  ) {
    return;
  }

  for (const series of results) {
    renderMetricCard(series, period);
  }

  if (!opts["all"] && !opts["metric"]) {
    console.log(
      `（${t("metric.defaultHint", { shown: DEFAULT_METRIC_KEYS.length, total: METRICS.length })}`,
    );
    console.log(t("metric.pickHint"));
  }
  if (!scope) {
    console.log(t("scope.pickHint"));
  }
  console.log(t("usage.trend.rankHint"));
}

/** 打印指标清单，供 --metric 取值 */
async function listMetrics(globals: GlobalArgs): Promise<void> {
  await warmMetricLabels(globals);
  console.log(t("usage.trend.listHeader"));
  console.log("");
  for (const m of METRICS) {
    const star = DEFAULT_METRIC_KEYS.includes(m.key) ? " *" : "  ";
    const named = metricLabel(m);
    console.log(`${star} ${pad(m.key, 22)} ${pad(named.label, 32)} ${named.unit}`);
  }
  console.log("");
  console.log(t("metric.listStar"));
  console.log(t("usage.trend.listLegend"));
}

async function exportCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const metricType = opts["metricType"] ?? "tokens";
  if (!["tokens", "search"].includes(metricType)) {
    throw new Error(t("usage.export.unsupported"));
  }

  const client = buildClient(globals);
  const params = buildParams(opts);
  // 导出要拿全量，不分页
  params["ShowAll"] = true;

  const resp = await client.call("DescribeUsageRankList", params);
  const topList = (resp["TopList"] as TopItem[] | undefined) ?? [];
  const metricKeys = (resp["MetricKeys"] as string[] | undefined) ?? [];

  // JSON 模式直接把数据吐到 stdout，不落 CSV 文件：调用方已经能拿到结构化数据，
  // 再顺手写个文件属于意料之外的副作用。要文件就别加 --json。
  if (emitJson(resp)) return;

  const stamp = (value: unknown): string => String(value).replace(/[-:TZ]/g, "").slice(0, 12);
  const out =
    opts["output"] ??
    `usage_${String(params["Dimension"])}_${stamp(params["StartTime"])}_${stamp(params["EndTime"])}.csv`;

  // 列随 MetricKeys 动态生成，指标集变化时无需改代码
  const header = ["Rank", "Key", "Name", ...metricKeys].join(",");
  const lines = topList.map((item) =>
    [
      item.Rank ?? "",
      item.Key ?? "",
      // 名称可能含逗号，按 CSV 规则转义
      `"${String(item.Name ?? "").replace(/"/g, '""')}"`,
      ...metricKeys.map((k) => item.Stats?.[k] ?? 0),
    ].join(","),
  );
  fs.writeFileSync(out, `${[header, ...lines].join("\n")}\n`);

  console.log(
    t("usage.export.done", {
      count: topList.length,
      path: out,
      dimension: params["Dimension"],
      metricType,
      from: params["StartTime"],
      to: params["EndTime"],
    }),
  );
}

/** 装配 usage 命令组 */
export function registerUsageCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const usage = program.command("usage").description(t("group.usage.desc"));

  const commonOptions = (cmd: Command): Command =>
    cmd
      .option("--dimension <dim>", t("opt.dimension"), "model")
      .option("--start-time <time>", t("opt.startTime"))
      .option("--end-time <time>", t("opt.endTime"))
      .option("--target <target>", t("usage.opt.target"))
      .option("--metric-type <type>", t("opt.metricType"), "tokens")
      .option("--period <seconds>", t("opt.period", { default: DEFAULT_PERIOD }))
      .option("--offset <n>", t("usage.rank.opt.offset"));

  // 不提供 --offset/--show-all：rank 已在后台翻完全部分页，让图表/排行榜/汇总
  // 三者范围一致。暴露分页只会让用户看到"图表是本页、汇总是全量"的错位数据。
  commonOptions(usage.command("rank").description(t("usage.rank.desc")))
    .option("--color", t("usage.rank.opt.color"))
    .action(async (opts) => rankCommand(opts, getGlobals()));

  // trend 走云监控接口，默认账号整体，可按 model/endpoint/apikey 下钻
  usage
    .command("trend")
    .description(t("usage.trend.desc"))
    .option("--start-time <time>", t("opt.startTime"))
    .option("--end-time <time>", t("opt.endTime"))
    .option("--period <seconds>", t("opt.period", { default: DEFAULT_PERIOD }))
    .option("--model <name>", t("opt.model"))
    .option("--endpoint <id>", t("opt.endpoint"))
    .option("--apikey <id>", t("opt.apikey"))
    .option("--metric <keys>", t("opt.metric"))
    .option("--all", t("opt.allMetrics", { count: METRICS.length }))
    .option("--list-metrics", t("opt.listMetrics"))
    .action(async (opts) => {
      if (opts.listMetrics) {
        await listMetrics(getGlobals());
        return;
      }
      await trendCommand(opts, getGlobals());
    });

  commonOptions(usage.command("export").description(t("usage.export.desc")))
    .option("--output <path>", t("usage.export.opt.output"))
    .action(async (opts) => exportCommand(opts, getGlobals()));
}
