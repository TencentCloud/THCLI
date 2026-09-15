/**
 * monitor 命令组：服务健康度观测。
 *
 * 与 usage 的分工：
 *   usage    答"用了多少"——token 数、缓存命中、排行
 *   monitor  答"用得好不好"——请求量、错误率、延迟；以及非文本模型的产出量
 *            （视频时长、图片张数……那些模型不产生 token，usage 对它们是空图）
 *
 * 两个子命令对应两套指标：
 *   text    文本模型的健康度（13 个指标；默认账号整体，可按模型/服务/API Key 细分）
 *   vision  非文本模型的产出量与质量（指标集随模型类型而变，见 metricsForStrategy）
 */
import { Command } from "commander";

import { buildClient } from "../core/client.js";
import type { GlobalArgs } from "../core/credentials.js";
import { human, pad, verticalChart } from "../core/format.js";
import { emitJson, isJson } from "../core/output.js";
import { lang, t } from "../core/i18n.js";
import {
  buildMonitorClient,
  metricLabel,
  warmMetricLabels,
  DEFAULT_PERF_KEYS,
  DIMENSION_KEYS,
  type MetricMeta,
  type MetricSeries,
  metricsForStrategy,
  PERF_METRICS,
} from "../core/monitor.js";

/** 默认聚合粒度，与 usage 保持一致 */
const DEFAULT_PERIOD = 3600;

/** 按 key 找健康度指标，未知时列出可选值 */
function perfMetricByKey(key: string): MetricMeta {
  const hit = PERF_METRICS.find((m) => m.key === key);
  if (!hit) {
    throw new Error(
      `${t("metric.unknown", { key, options: PERF_METRICS.map((m) => m.key).join(", ") })}\n` +
        t("metric.unknownHint", { command: "thcli monitor text --list-metrics" }),
    );
  }
  return hit;
}

function defaultTimeRange(): { start: string; end: string } {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const fmt = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;
  return { start: fmt(dayAgo), end: fmt(now) };
}

/** 转成监控接口要的 ISO8601 带偏移格式 */
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

/** X 轴短标签 */
function axisLabel(ts: number, period: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return period >= 86400
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 带日期的时间标签，用于峰值标注 */
function timeLabel(ts: number, period: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return period >= 86400
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 按单位选合适的数值格式。
 * 百分比与毫秒不该套 K/M 单位（`85.00 %` 而非 `85.00`；`1.20 K ms` 反而难读）。
 */
function formatByUnit(unit: string): (value: number) => string {
  if (unit === "%") {
    return (v) => `${v.toFixed(2)}%`;
  }
  if (unit === "ms" || unit === "s") {
    return (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}k` : v.toFixed(v < 10 ? 2 : 0));
  }
  return (v) => human(v);
}

/**
 * --json 的数据结构，text 与 vision 共用。
 *
 * 图表是这些时序数据的可视化，所以 JSON 给的就是底层的 timestamps/values；
 * 指标名与单位一并带上，否则调用方拿到一串数字不知道量纲。
 */
function seriesPayload(
  uin: string,
  scope: Record<string, string>,
  query: { startTime: string; endTime: string },
  period: number,
  results: MetricSeries[],
): Record<string, unknown> {
  return {
    Uin: uin,
    Scope: scope,
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
  };
}

/** 画一个指标的卡片，与 usage trend 的形式一致 */
function renderMetricCard(series: MetricSeries, period: number): void {
  const { meta, timestamps, values } = series;
  const named = metricLabel(meta);
  // 括号随语言走：英文界面里全角「（）」很扎眼
  console.log(lang() === "en" ? `${named.label} (${named.unit})` : `${named.label}（${named.unit}）`);

  if (series.drilldownIgnored) {
    console.log(`  ${t("metric.uinOnlyNote")}`);
  }

  const present = values.filter((v): v is number => typeof v === "number");
  if (!timestamps.length || !present.length) {
    console.log(`  ${t("chart.noData")}`);
    console.log("");
    return;
  }

  const fmt = formatByUnit(named.unit);
  const chart = verticalChart(values, (i) => axisLabel(timestamps[i] ?? 0, period), fmt);
  for (const row of chart.rows) {
    console.log(row);
  }
  console.log(chart.axis);
  console.log(chart.labels);

  const max = Math.max(...present);
  const min = Math.min(...present);
  const avg = present.reduce((sum, v) => sum + v, 0) / present.length;
  const peakAt = timestamps[values.findIndex((v) => v === max)];
  const peakNote =
    peakAt === undefined ? "" : t("chart.peakAt", { when: timeLabel(peakAt, period) });
  console.log(
    `  ${t("chart.range", {
      from: timeLabel(timestamps[0] ?? 0, period),
      to: timeLabel(timestamps[timestamps.length - 1] ?? 0, period),
    })}`,
  );
  console.log(
    `  ${t("chart.stats", {
      max: pad(fmt(max), 10),
      peak: peakNote,
      min: pad(fmt(min), 10),
      avg: fmt(avg),
    })}`,
  );
  console.log("");
}

/** monitor text：账号级服务健康度 */
async function textCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  if (opts["listMetrics"]) {
    await warmMetricLabels(globals);
    console.log(t("monitor.text.listHeader"));
    console.log("");
    for (const m of PERF_METRICS) {
      const star = DEFAULT_PERF_KEYS.includes(m.key) ? " *" : "  ";
      const scopeNote = m.uinOnly ? t("monitor.text.scopeAccountOnly") : t("monitor.text.scopeBreakdown");
      const named = metricLabel(m);
      console.log(
        `${star} ${pad(m.key, 16)} ${pad(named.label, 20)} ${pad(named.unit, 10)} ${scopeNote}`,
      );
    }
    console.log("");
    console.log(t("metric.listStar"));
    console.log(t("monitor.text.listLegend"));
    return;
  }

  const period = opts["period"] === undefined ? DEFAULT_PERIOD : Number(opts["period"]);
  const range = defaultTimeRange();

  // 下钻维度：不给则看账号整体
  const filters: Record<string, string> = {};
  for (const key of DIMENSION_KEYS) {
    const value = opts[key];
    if (value) {
      filters[key] = String(value);
    }
  }

  const query = {
    startTime: toOffsetIso(opts["startTime"] ?? range.start),
    endTime: toOffsetIso(opts["endTime"] ?? range.end),
    period,
    filters,
  };

  const requested = opts["metric"]
    ? String(opts["metric"])
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_PERF_KEYS;
  const metrics = opts["all"] ? PERF_METRICS : requested.map(perfMetricByKey);

  const client = await buildMonitorClient(globals);
  const scope = Object.entries(filters)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  // JSON 模式不能先打标题：stdout 里混进人类可读文本会让解析直接失败
  if (!isJson()) {
    console.log(
      t("monitor.text.title", {
        uin: client.uin,
        scope: scope || t("scope.allObjects"),
        from: query.startTime,
        to: query.endTime,
        period,
      }),
    );
    console.log("");
  }

  // 监控接口「仅支持单指标拉取」，故每个指标一次请求，并发发出
  const results = await Promise.all(metrics.map((meta) => client.fetch(meta, query)));

  if (emitJson(seriesPayload(client.uin, filters, query, period, results))) return;

  for (const series of results) {
    renderMetricCard(series, period);
  }

  if (!opts["all"] && !opts["metric"]) {
    console.log(
      `（${t("metric.defaultHint", { shown: DEFAULT_PERF_KEYS.length, total: PERF_METRICS.length })}`,
    );
    console.log(t("metric.pickHint"));
  }
  if (!scope) {
    console.log(t("scope.pickHint"));
  }
  console.log(t("monitor.text.visionHint"));
}

/** AIGC 模型条目，用于查 UsageDisplayStrategy */
interface AigcModel {
  ModelID?: string;
  ModelType?: string;
  UsageDisplayStrategy?: string;
}

/** monitor vision：非文本模型（图片/视频/音频/3D）的产出量与质量 */
/**
 * 模态分组。依据是 DescribeAIGCModelList 的 ModelType——实测 49 个非文本模型
 * 全部落在这两组里（Image/Video 35 个 + Audio/ASR/TTS 14 个，无遗漏），
 * 故按此拆成 vision / audio 两个子命令，与控制台的页面划分一致。
 *
 * 注意 3D 模型（hy-world2-*）的 ModelType 是 Image/Video，归 vision——
 * 它只是 UsageDisplayStrategy 特殊，不是独立模态。
 */
const MODALITY_TYPES = {
  vision: ["Image", "Video"],
  audio: ["Audio", "ASR", "TTS"],
} as const;

type Modality = keyof typeof MODALITY_TYPES;

/**
 * monitor vision / audio 的共用实现。
 *
 * 两者的指标名与结构完全相同（都是 rpm/total_token/multimodal_usage/error_ratio/
 * duration 五项），差别只在 multimodal_usage 那一项的含义：视频是时长、图片是张数、
 * TTS 是输入字符数……由模型的 UsageDisplayStrategy 决定，见 metricsForStrategy。
 * 拆两个子命令的收益是 --list-models 的清单各自更短，找模型时不必在图片里翻语音。
 */
async function modalityCommand(
  modality: Modality,
  opts: Record<string, string>,
  globals: GlobalArgs,
): Promise<void> {
  const client = buildClient(globals);
  // 先取 AIGC 模型清单：每个模型的 UsageDisplayStrategy 决定它适用哪套指标。
  // 这不是推断——同一个 UinModelMultimodalUsage 在视频下是「时长(s)」、
  // 在图片下是「张数(Count)」，不问清楚就会标错量纲。
  const listResp = await client.call("DescribeAIGCModelList", {});
  const allModels = (listResp["ModelList"] as AigcModel[] | undefined) ?? [];
  const wantedTypes: readonly string[] = MODALITY_TYPES[modality];
  const models = allModels.filter((m) => wantedTypes.includes(m.ModelType ?? ""));

  if (opts["listModels"]) {
    console.log(t(`monitor.${modality}.listHeader`));
    console.log("");
    const byType = new Map<string, AigcModel[]>();
    for (const m of models) {
      const key = m.ModelType ?? "?";
      byType.set(key, [...(byType.get(key) ?? []), m]);
    }
    for (const [type, list] of [...byType.entries()].sort()) {
      console.log(t("monitor.vision.typeGroup", { type, count: list.length }));
      for (const m of list) {
        console.log(`  ${m.ModelID}`);
      }
      console.log("");
    }
    return;
  }

  const wanted = opts["model"];
  if (!wanted) {
    console.log(t(`monitor.${modality}.needModel`));
    console.log(t(`monitor.${modality}.countHint`, { count: models.length }));
    return;
  }

  const hit = models.find((m) => m.ModelID === wanted);
  if (!hit) {
    console.log(t(`monitor.${modality}.notFound`, { model: wanted }));
    // 模型存在但属另一模态时直接指路，别让用户自己猜该换哪个子命令
    const otherModality: Modality = modality === "vision" ? "audio" : "vision";
    const inOther = allModels.find(
      (m) =>
        m.ModelID === wanted &&
        (MODALITY_TYPES[otherModality] as readonly string[]).includes(m.ModelType ?? ""),
    );
    console.log(
      inOther
        ? t(`monitor.${modality}.crossHint`, { model: wanted })
        : t("monitor.vision.useTrend"),
    );
    return;
  }

  const metrics = metricsForStrategy(hit.UsageDisplayStrategy);
  const period = opts["period"] === undefined ? DEFAULT_PERIOD : Number(opts["period"]);
  const range = defaultTimeRange();
  const query = {
    startTime: toOffsetIso(opts["startTime"] ?? range.start),
    endTime: toOffsetIso(opts["endTime"] ?? range.end),
    period,
    filters: { model: wanted },
  };

  const monitor = await buildMonitorClient(globals);
  if (!isJson()) {
    console.log(
      t("monitor.vision.title", {
        model: wanted,
        type: hit.ModelType ?? "-",
        uin: monitor.uin,
        from: query.startTime,
        to: query.endTime,
        period,
      }),
    );
    console.log("");
  }

  const results = await Promise.all(metrics.map((meta) => monitor.fetch(meta, query)));

  if (
    emitJson({
      ...seriesPayload(monitor.uin, { model: wanted }, query, period, results),
      ModelType: hit.ModelType,
    })
  ) {
    return;
  }

  for (const series of results) {
    renderMetricCard(series, period);
  }
  console.log(t("monitor.vision.textHint"));
}

/** 装配 monitor 命令组 */
export function registerMonitorCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const monitor = program
    .command("monitor")
    .description(t("group.monitor.desc"));

  monitor
    .command("text")
    .description(t("monitor.text.desc"))
    .option("--start-time <time>", t("opt.startTime"))
    .option("--end-time <time>", t("opt.endTime"))
    .option("--period <seconds>", t("opt.period", { default: DEFAULT_PERIOD }))
    .option("--model <name>", t("opt.model"))
    .option("--endpoint <id>", t("opt.endpoint"))
    .option("--apikey <id>", t("opt.apikey"))
    .option("--metric <keys>", t("opt.metric"))
    .option("--all", t("opt.allMetrics", { count: PERF_METRICS.length }))
    .option("--list-metrics", t("opt.listMetrics"))
    .action(async (opts) => textCommand(opts, getGlobals()));

  // vision 与 audio 共用一份实现，只差模型清单的过滤范围（见 modalityCommand）
  for (const modality of ["vision", "audio"] as const) {
    monitor
      .command(modality)
      .description(t(`monitor.${modality}.desc`))
      .option("--model <id>", t("monitor.vision.opt.model"))
      .option("--start-time <time>", t("opt.startTime"))
      .option("--end-time <time>", t("opt.endTime"))
      .option("--period <seconds>", t("opt.period", { default: DEFAULT_PERIOD }))
      .option("--list-models", t("monitor.vision.opt.listModels"))
      .action(async (opts) => modalityCommand(modality, opts, getGlobals()));
  }
}
