/**
 * 云监控（Barad）指标查询：QCE/TOKEN_HUB 命名空间下的用量指标。
 *
 * 用的是不带 Uin 前缀的那套指标（TotalToken 而非 UinTotalToken）——经
 * DescribeBaseMetrics 查证，它们的维度是 [uin, modelname, endpoint, apikeyid]：
 * 只传 uin 时返回账号级聚合（实测与 UinTotalToken 完全一致），追加 modelname
 * 等维度即可下钻到具体对象。带 Uin 前缀的那套只有 uin 维度，无法下钻。
 *
 * 与管控面 DescribeUsageRankList 的分工：
 *   排行接口  给"谁用得多"的排名，一次返回全部对象的横向对比
 *   监控接口  给时序走势，指标更细（缓存读写分离、TPM）
 *
 * 指标中文名与单位取自控制台 DescribeMonitorProductByIds 的 usage_uin_policy，
 * 不是推断值。注意 cache_token 的中文名带"每分钟"但单位是 Count，这是上游元数据
 * 的原样，不做"纠正"。
 */
import { CommonClient } from "tencentcloud-sdk-nodejs-common";

import { cloudApiHostOf } from "./config.js";
import { agentForEnv } from "./http-agent.js";
import { parseGlobalArgs, resolveEnv, type GlobalArgs } from "./credentials.js";
import { resolveIdentity } from "./identity.js";
import { lang, t } from "./i18n.js";
import { maybeRefreshCredential } from "./oauth.js";

/** 监控指标的命名空间 */
const NAMESPACE = "QCE/TOKEN_HUB";

const MONITOR_PRODUCT = "monitor";
const MONITOR_VERSION = "2018-07-24";

/** 单个指标的元信息 */
export interface MetricMeta {
  /** 云 API 的 MetricName（驼峰，如 UinTotalToken） */
  name: string;
  /** CLI 里用的短名，用户用它做 --metric 的取值 */
  key: string;
  /** 中文名，取自控制台元数据 */
  label: string;
  /** 单位，取自控制台元数据 */
  unit: string;
  /**
   * 控制台元数据里的键（snake_case）。用于运行时按语言取名，不能从 name
   * 机械推导——`uin_view_input_tpm` 对应的是 `InputTpm` 而非 `ViewInputTpm`。
   */
  metaKey?: string;
  /**
   * 只支持 uin 维度：带 modelname 等下钻条件会查不到数据。
   * 目前只有 SuccessCount/ErrorCount 属此列（实测其无前缀版全无数据），
   * 由调用方在下钻时明确提示，而不是静默返回空图。
   */
  uinOnly?: boolean;
}

/**
 * 与控制台「用量趋势」页对齐的用量指标，顺序一致便于对照。
 *
 * 都用不带 Uin 前缀的名字——经 DescribeBaseMetrics 查证，这套的维度是
 * [uin, modelname, endpoint, apikeyid]，只传 uin 时与带 Uin 前缀的那套结果
 * 完全一致（实测 Tpm 与 UinTpm 同区间均为 8.14M），但额外支持按对象下钻。
 *
 * 控制台还有「平均输入/输出Token」两项，对应 UinModelMstypeInputTpm /
 * UinModelMstypeOutputTpm，需要 mstype 维度。mstype 的合法取值未知（试过
 * chat/text/vision/speech/embedding 等均返回 0 点），故暂不提供，
 * 避免给出永远空白的图。
 */
export const METRICS: MetricMeta[] = [
  { name: "TotalToken", key: "total", label: "总Token数", unit: "Count", metaKey: "uin_total_token" },
  { name: "InputTotalToken", key: "input", label: "输入Token数", unit: "Count", metaKey: "uin_input_total_token" },
  { name: "OutputTotalToken", key: "output", label: "输出Token数", unit: "Count", metaKey: "uin_output_total_token" },
  { name: "Tpm", key: "tpm", label: "每分钟总Token数", unit: "tokens/min", metaKey: "uin_tpm" },
  { name: "InputTpm", key: "input-tpm", label: "每分钟输入Token数", unit: "tokens/min", metaKey: "uin_view_input_tpm" },
  { name: "OutputTpm", key: "output-tpm", label: "每分钟输出Token数", unit: "tokens/min", metaKey: "uin_output_tpm" },
  { name: "CacheToken", key: "cache-read", label: "每分钟读缓存token数", unit: "Count", metaKey: "uin_cache_token" },
  {
    name: "CacheCreationToken",
    key: "cache-write",
    label: "每分钟写入缓存token数",
    unit: "Count",
    metaKey: "uin_cache_creation_token",
  },
  { name: "TotalCacheToken", key: "cache-read-total", label: "读缓存总token数", unit: "Count", metaKey: "uin_total_cache_token" },
  {
    name: "TotalCacheCreationToken",
    key: "cache-write-total",
    label: "写入缓存总token数",
    unit: "Count",
    metaKey: "uin_total_cache_creation_token",
  },
  {
    name: "ExplicitCacheToken",
    key: "explicit-cache",
    label: "每分钟读显式缓存的token数",
    unit: "Count",
    metaKey: "uin_explicit_cache_token",
  },
  {
    name: "TotalExplicitCacheToken",
    key: "explicit-cache-total",
    label: "区间内命中显式缓存的总token数",
    unit: "Count",
    metaKey: "uin_total_explicit_cache_token",
  },
];

/**
 * 缺省展示的指标：总量三件套 + 每分钟总量。
 * 不默认全拉——监控接口「仅支持单指标拉取」，拉 N 个就是 N 次请求。
 */
export const DEFAULT_METRIC_KEYS = ["total", "input", "output", "tpm"];

/** 按 key 找指标，找不到时报错并列出可选值 */
export function metricByKey(key: string): MetricMeta {
  const hit = METRICS.find((m) => m.key === key);
  if (!hit) {
    throw new Error(
      `${t("metric.unknown", { key, options: METRICS.map((m) => m.key).join(", ") })}\n` +
        t("metric.unknownHint", { command: "thcli usage trend --list-metrics" }),
    );
  }
  return hit;
}

/**
 * 服务健康度指标。中文名与单位取自控制台 DescribeMonitorProductByIds 的
 * perf_uin_policy。
 *
 * 用不带 Uin 前缀的名字（`Rpm` 而非 `UinRpm`）——经 DescribeBaseMetrics 查证它们
 * 的维度是 [uin, modelname, endpoint, apikeyid]，只传 uin 时与带前缀的那套结果完全
 * 一致（实测 Rpm/ErrorRatio/Ttft/NonStreamLatency/CacheHitRatio 五项均值逐一相同），
 * 但额外支持按模型/服务/Key 下钻。
 *
 * 两个例外用 Uin 版：SuccessCount 与 ErrorCount 的无前缀版
 * （ModelSuccessCount/ModelErrorCount）实测无论带不带 modelname 都返回空，
 * 故这两项只能看账号级，下钻时会明确提示（见 uinOnly）。
 */
export const PERF_METRICS: MetricMeta[] = [
  { name: "Rpm", key: "rpm", label: "每分钟请求数", unit: "reqs/min", metaKey: "uin_rpm" },
  {
    name: "UinSuccessCount",
    key: "success",
    label: "调用成功次数",
    unit: "reqs/min",
    metaKey: "uin_success_count",
    uinOnly: true,
  },
  {
    name: "UinErrorCount",
    key: "errors",
    label: "调用失败次数",
    unit: "reqs/min",
    metaKey: "uin_error_count",
    uinOnly: true,
  },
  { name: "ErrorRatio", key: "error-ratio", label: "错误率", unit: "%", metaKey: "uin_error_ratio" },
  { name: "ClientErrorRatio", key: "client-error", label: "客户端错误率", unit: "%", metaKey: "uin_client_error_ratio" },
  { name: "ServerErrorRatio", key: "server-error", label: "服务端错误率", unit: "%", metaKey: "uin_server_error_ratio" },
  { name: "RateLimitedRatio", key: "rate-limited", label: "429限流错误率", unit: "%", metaKey: "uin_rate_limited_ratio" },
  { name: "RpmOverRatio", key: "rpm-over", label: "RPM限流率", unit: "%", metaKey: "uin_rpm_over_ratio" },
  { name: "CanceledRatio", key: "canceled", label: "超时错误率", unit: "%", metaKey: "uin_canceled_ratio" },
  { name: "Ttft", key: "ttft", label: "首Token延迟", unit: "ms", metaKey: "uin_ttft" },
  { name: "Tpot", key: "tpot", label: "每Token输出时延", unit: "ms", metaKey: "uin_tpot" },
  { name: "NonStreamLatency", key: "latency", label: "非流式接口延时", unit: "ms", metaKey: "uin_non_stream_latency" },
  { name: "CacheHitRatio", key: "cache-hit", label: "缓存命中率", unit: "%", metaKey: "uin_cache_hit_ratio" },
];

/** monitor 缺省展示的健康度指标：请求量、错误率、两个关键延迟 */
export const DEFAULT_PERF_KEYS = ["rpm", "error-ratio", "ttft", "latency"];

/**
 * 非文本模型（图片/视频/音频/3D）的按模型指标。
 *
 * 关键：`uin_model_multimodal_usage` 这一个指标名在不同模型类型下**含义与单位都不同**
 * ——视频是「视频时长(s)」、音乐是「音乐数量(Count)」、图片是「图片张数(Count)」、
 * TTS 是「输入字符数(Count)」…… 共 7 种。所以不能写死一份元数据，必须按模型的
 * UsageDisplayStrategy 取对应那份（下表来自控制台 DescribeMonitorProductByIds）。
 */
const AIGC_USAGE_LABEL: Record<string, { label: string; unit: string }> = {
  usage_uin_model_video_model_policy: { label: "视频时长", unit: "s" },
  usage_uin_model_image_model_policy: { label: "图片张数", unit: "Count" },
  usage_uin_model_3d_model_policy: { label: "3D数量", unit: "Count" },
  usage_uin_model_audio_music_model_policy: { label: "音乐数量", unit: "Count" },
  usage_uin_model_audio_tts_model_policy: { label: "输入字符数/字节数", unit: "Count" },
  usage_uin_model_audio_tts_voice_model_policy: { label: "生成音色数", unit: "Count" },
  usage_uin_model_audio_asr_model_policy: { label: "音频/视频时长", unit: "s" },
  usage_uin_model_audio_dubbing_model_policy: { label: "音频/视频时长", unit: "s" },
};

/** 视觉类模型只有请求数与积分两项（usage_uin_vision_model_policy） */
const VISION_ONLY_POLICY = "usage_uin_vision_model_policy";

/**
 * 按模型的 UsageDisplayStrategy 取该模型适用的指标集。
 * strategy 未知时退回通用四项（不含 multimodal_usage——它的含义依赖 strategy，
 * 猜错会把「图片张数」标成「视频时长」这种量纲错误）。
 */
export function metricsForStrategy(strategy: string | undefined): MetricMeta[] {
  const base: MetricMeta[] = [
    { name: "UinModelRpm", key: "rpm", label: "每分钟请求数", unit: "reqs/min" },
    { name: "UinModelTotalToken", key: "token", label: "Token消耗数", unit: "Count" },
    { name: "UinModelErrorRatio", key: "error-ratio", label: "错误率", unit: "%" },
    { name: "UinModelDuration", key: "duration", label: "任务时长", unit: "s" },
  ];

  if (strategy === VISION_ONLY_POLICY) {
    return [
      { name: "UinModelRpm", key: "rpm", label: "每分钟请求数", unit: "reqs/min" },
      { name: "UinModelCredits", key: "credits", label: "积分消耗数", unit: "count" },
    ];
  }

  const usage = strategy ? AIGC_USAGE_LABEL[strategy] : undefined;
  if (!usage) {
    return base;
  }
  // 产出量指标放在最前——它才是这类模型的核心口径（视频看时长、图片看张数）
  return [
    { name: "UinModelMultimodalUsage", key: "usage", label: usage.label, unit: usage.unit },
    ...base,
  ];
}

/** 一个指标的时序结果 */
export interface MetricSeries {
  meta: MetricMeta;
  timestamps: number[];
  values: Array<number | null>;
  /** 本次是否因指标只支持 uin 维度而忽略了下钻条件 */
  drilldownIgnored?: boolean;
}

/** 元数据里一条指标的中英文名与单位 */
interface MetricLabelPair {
  zh: string;
  en: string;
  unitZh: string;
  unitEn: string;
}

/** 进程内缓存：同一次执行里多个指标共用一次元数据请求 */
let labelCache: Map<string, MetricLabelPair> | undefined;

/**
 * 拉控制台元数据，得到「指标 → 中英文名」映射。
 *
 * 为什么运行时拉而不写死英文名：上游元数据自带 enMetricCName/enUnit，写死会与
 * 后端改名脱节。一次请求覆盖两个 policy（实测 346ms），且进程内缓存，
 * 故一条命令只付一次开销。
 *
 * 拉取失败不阻断——回退到代码里的中文 label（见 metricLabel），
 * 观测命令不该因为元数据服务抖动就不能用。
 */
async function loadMetricLabels(
  monitor: CommonClient,
): Promise<Map<string, MetricLabelPair>> {
  if (labelCache) {
    return labelCache;
  }
  const map = new Map<string, MetricLabelPair>();
  try {
    const resp = (await monitor.request("DescribeMonitorProductByIds", {
      ProductIds: ["usage_uin_policy", "perf_uin_policy"],
      Module: "monitor",
    })) as { ProductList?: Array<{ Meta?: string }> };
    for (const product of resp.ProductList ?? []) {
      const meta = JSON.parse(product.Meta ?? "{}") as {
        metrics?: Array<{
          metricName?: string;
          metricCName?: string;
          enMetricCName?: string;
          unit?: string;
          enUnit?: string;
        }>;
      };
      for (const item of meta.metrics ?? []) {
        if (!item.metricName) {
          continue;
        }
        map.set(item.metricName, {
          zh: item.metricCName ?? "",
          en: item.enMetricCName ?? item.metricCName ?? "",
          unitZh: item.unit ?? "",
          unitEn: item.enUnit ?? item.unit ?? "",
        });
      }
    }
  } catch {
    // 元数据拉不到就用代码里的中文名，不让观测命令挂掉
  }
  labelCache = map;
  return map;
}

/**
 * 预热指标名缓存，供 --list-metrics 这类不建监控客户端的命令用。
 *
 * 它们只列清单、不查数据，本来不需要 monitor 客户端；但指标的双语名在元数据里，
 * 不拉一次就只能显示代码里的中文兜底值（英文界面里很突兀）。
 * 拉取失败静默回退，清单照样能出。
 */
export async function warmMetricLabels(args: GlobalArgs): Promise<void> {
  if (labelCache) {
    return;
  }
  try {
    const cred = parseGlobalArgs(args);
    if (!cred.secretId || !cred.secretKey) {
      return;
    }
    const monitor = new CommonClient(cloudApiHostOf(resolveEnv(), MONITOR_PRODUCT), MONITOR_VERSION, {
      credential: { secretId: cred.secretId, secretKey: cred.secretKey, token: cred.token },
      region: cred.region,
      profile: { httpProfile: { agent: agentForEnv(resolveEnv()) } },
    });
    await loadMetricLabels(monitor);
  } catch {
    // 没凭证或网络不通都不影响列清单
  }
}

/** 按当前语言取指标显示名与单位；元数据缺失时回退到代码里的值 */
export function metricLabel(meta: MetricMeta): { label: string; unit: string } {
  const pair = meta.metaKey ? labelCache?.get(meta.metaKey) : undefined;
  if (!pair) {
    return { label: meta.label, unit: meta.unit };
  }
  const en = lang() === "en";
  return {
    label: (en ? pair.en : pair.zh) || meta.label,
    unit: (en ? pair.unitEn : pair.unitZh) || meta.unit,
  };
}

/** 监控查询客户端 */
export interface MonitorClient {
  /** 主账号 uin，指标维度要用它 */
  uin: string;
  /** 拉单个指标的时序 */
  fetch(meta: MetricMeta, params: MonitorQuery): Promise<MetricSeries>;
}

/** 可下钻的维度名。uin 由客户端自动带上，不在此列 */
export const DIMENSION_KEYS = ["model", "endpoint", "apikey"] as const;

/** CLI 的维度短名 → 云监控的维度名 */
const DIMENSION_API_NAME: Record<string, string> = {
  model: "modelname",
  endpoint: "endpoint",
  apikey: "apikeyid",
};

/** 查询区间、粒度与可选的下钻维度 */
export interface MonitorQuery {
  startTime: string;
  endTime: string;
  period: number;
  /**
   * 下钻到具体对象。留空则只按 uin 查，得到账号级聚合。
   * 键是 DIMENSION_KEYS 里的短名，值是对象标识（模型名/端点 ID/密钥 ID）。
   */
  filters?: Record<string, string>;
}

/** 把 CLI 的维度短名翻成云监控的维度名，未知名字明确报错 */
export function toApiDimension(key: string): string {
  const name = DIMENSION_API_NAME[key];
  if (!name) {
    throw new Error(`未知维度 ${key}，可选：${DIMENSION_KEYS.join(", ")}`);
  }
  return name;
}

/**
 * 建监控客户端。会先查一次 sts:GetCallerIdentity 拿主账号 uin——指标维度是
 * uin，而本地凭证里只有 openId，没有 uin，故必须问一次云端。
 */
export async function buildMonitorClient(args: GlobalArgs): Promise<MonitorClient> {
  const initial = parseGlobalArgs(args);
  await maybeRefreshCredential(initial.profile, initial.site);
  const cred = parseGlobalArgs(args);
  if (!cred.secretId || !cred.secretKey) {
    throw new Error("未找到腾讯云凭证，请先执行 thcli auth login 或 thcli auth set");
  }

  const clientConfig = {
    credential: { secretId: cred.secretId, secretKey: cred.secretKey, token: cred.token },
    region: cred.region,
    // agent 见 core/http-agent.ts：按环境配置强制解析集群 IP 并按需放宽证书
    profile: { httpProfile: { agent: agentForEnv(resolveEnv()) } },
  };

  // uin 走 cam:GetUserAppId（见 core/identity.ts）而不是 sts:GetCallerIdentity——
  // 后者不接受第三方联合身份的临时密钥，报 AccessKeyNotSupport
  const { uin } = await resolveIdentity(args);

  const monitor = new CommonClient(
    cloudApiHostOf(resolveEnv(), MONITOR_PRODUCT),
    MONITOR_VERSION,
    clientConfig,
  );
  // 开始拉指标名，但不在这里 await——让它与后续的指标查询并发。
  // 各 fetch 内部会 await 这个 promise，保证渲染时名字已就绪
  // （曾用 void 丢弃它，结果渲染早于缓存填充，英文界面仍显示中文名）。
  const labelsReady = loadMetricLabels(monitor);

  return {
    uin,
    async fetch(meta, query) {
      // 指标名与数据并发拉取，二者都就绪后再返回
      await labelsReady;
      // uin 始终带上；额外维度用于下钻到具体模型/推理服务/API Key。
      // uinOnly 指标带上下钻条件会查不到数据，故跳过并标记，由调用方告知用户。
      const wanted = Object.entries(query.filters ?? {});
      const drilldownIgnored = meta.uinOnly === true && wanted.length > 0;
      const dimensions = [{ Name: "uin", Value: uin }];
      if (!drilldownIgnored) {
        for (const [key, value] of wanted) {
          dimensions.push({ Name: toApiDimension(key), Value: value });
        }
      }

      const resp = (await monitor.request("GetMonitorData", {
        Namespace: NAMESPACE,
        MetricName: meta.name,
        Instances: [{ Dimensions: dimensions }],
        Period: query.period,
        StartTime: query.startTime,
        EndTime: query.endTime,
      })) as {
        DataPoints?: Array<{ Timestamps?: number[]; Values?: Array<number | null> }>;
      };
      const point = resp.DataPoints?.[0];
      return {
        meta,
        timestamps: point?.Timestamps ?? [],
        values: point?.Values ?? [],
        drilldownIgnored,
      };
    },
  };
}
