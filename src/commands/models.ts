/**
 * models 命令组：模型广场的列表 / 详情 / 比价。
 *
 * 云 API 只有 DescribeModelList 一个查询入口，"单模型详情"用 ModelIds 精确过滤
 * 取一条实现（详情 = 列表单条的完整视图）。
 */
import { Command } from "commander";

import { buildClient } from "../core/client.js";
import { emitJson } from "../core/output.js";
import { t } from "../core/i18n.js";
import { confirm } from "../core/prompt.js";
import type { GlobalArgs } from "../core/credentials.js";
import {
  displayWidth,
  human,
  pad,
  printAligned,
  printTable,
  splitCsv,
  summaryLine,
} from "../core/format.js";

interface ChargingItem {
  PriceName?: string;
  DisplayName?: string;
  Price?: string;
  /** 价格单位，后端按当前语言给好（如 元/百万tokens、$/1M tokens、积分/次） */
  PriceUnit?: string;
}

/**
 * 一组计费信息。**Type 与 Name 不能省**：阶梯计价的每一档是数组里独立一项，
 * 而区分它们的档位标识只存在 Name 里。少了这两个字段，渲染层就只能把各档的条目
 * 平铺成一串，同名维度（多个「输入」）重复出现且无从归属——读的人和 Agent 都
 * 判断不出哪个价对应哪一档。
 */
interface ChargingGroup {
  /** Uniform（统一计价）| Tiered（阶梯计价） */
  Type?: string;
  /** 阶梯计价时的区间标识；统一计价为空 */
  Name?: string;
  /** 计费场景，用于区分同一模型不同功能的计价 */
  Scenario?: string;
  ChargingItems?: ChargingItem[];
  /** TOKEN | COUNT | CREDIT | PICTURE */
  ChargeUnit?: string;
}

interface Model {
  ModelId?: string;
  ModelName?: string;
  DisplayName?: string;
  Description?: string;
  Summary?: string;
  ModelType?: string;
  Brand?: string;
  Provider?: string;
  Status?: string;
  Tags?: string[];
  ModelSeries?: string;
  ModelSpec?: Record<string, unknown>;
  ModelChargingInfo?: ChargingGroup[];
  FreeTrialInfo?: Record<string, unknown>;
  SupportExperience?: boolean;
  RecommendWeight?: number;
}

/**
 * 计费分组的档位标签，无档位时返回空串。
 *
 * 只有阶梯计价才需要标签：统一计价的 Name 本来就是空的，硬给它编一个标题反而让
 * 单档模型看起来像多档。Scenario 用于区分同一模型的不同功能（如文生图 / 图生图），
 * 有值时一并带上，否则同一模型的多个场景也会分不清。
 */
function tierLabel(group: ChargingGroup): string {
  const parts = [group.Name, group.Scenario].filter((s): s is string => Boolean(s));
  return parts.join(" · ");
}

/** list 与 pricing 共用的过滤参数装配 */
function buildListParams(opts: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (opts["type"]) params["ModelTypes"] = splitCsv(opts["type"]);
  if (opts["ids"]) params["ModelIds"] = splitCsv(opts["ids"]);
  if (opts["names"]) params["ModelNames"] = splitCsv(opts["names"]);
  if (opts["tags"]) params["Tags"] = splitCsv(opts["tags"]);
  if (opts["limit"] !== undefined) params["Limit"] = Number(opts["limit"]);
  if (opts["offset"] !== undefined) params["Offset"] = Number(opts["offset"]);
  return params;
}

async function listCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = buildClient(globals);
  const params = buildListParams(opts);
  const resp = await client.call("DescribeModelList", params);
  const models = (resp["ModelSet"] as Model[] | undefined) ?? [];

  if (emitJson(resp)) return;

  printTable(
    ["MODEL_ID", "NAME", "TYPE", "STATUS", "TAGS"],
    models.map((m) => [
      m.ModelId ?? "",
      m.ModelName ?? "",
      m.ModelType ?? "",
      m.Status ?? "",
      (m.Tags ?? []).join(","),
    ]),
  );
  console.log(summaryLine(resp["TotalCount"], models.length, params["Offset"]));
}

async function getCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const modelId = opts["id"];
  if (!modelId) {
    throw new Error(t("models.get.needId"));
  }
  const client = buildClient(globals);
  const resp = await client.call("DescribeModelList", { ModelIds: [modelId] });
  const models = (resp["ModelSet"] as Model[] | undefined) ?? [];
  const model = models.find((m) => m.ModelId === modelId);
  if (!model) {
    // JSON 模式也得吐 JSON：混进一句人类可读的提示会让解析方直接报错
    if (emitJson(null)) return;
    console.log(t("models.get.notFound", { id: modelId }));
    return;
  }

  // 单模型查询给出那一个模型本身，而不是包着数组的整个响应——调用方要的是这个对象
  if (emitJson(model)) return;

  const rows: Array<[string, string]> = [
    [t("models.label.id"), model.ModelId ?? ""],
    [
      t("models.label.name"),
      t("models.nameWithDisplay", { name: model.ModelName ?? "", display: model.DisplayName ?? "" }),
    ],
    [t("models.label.type"), model.ModelType ?? ""],
    [t("models.label.brand"), `${model.Brand || "-"} / ${model.Provider || "-"}`],
    [t("models.label.status"), model.Status ?? ""],
  ];
  const tags = model.Tags ?? [];
  rows.push([t("models.label.tags"), tags.length ? tags.join(",") : "-"]);
  if (model.Description) {
    rows.push([t("models.label.description"), model.Description]);
  }

  const spec = model.ModelSpec ?? {};
  if (Object.keys(spec).length) {
    rows.push([
      t("models.label.spec"),
      t("models.specValue", {
        context: spec["ContextLength"] ?? "-",
        maxInput: spec["MaxInputToken"] ?? "-",
        maxOutput: spec["MaxOutputToken"] ?? "-",
        tpm: spec["TPM"] ?? "-",
        qpm: spec["QPM"] ?? "-",
      }),
    ]);
  }

  // 计费明细分多行，故只把标签并入对齐表、值留空，明细跟在后面缩进打印。
  // printAligned 必须在 if 外面——曾误放进 if 里，导致无计费信息的模型
  // 连模型 ID/名称/规格都不打印
  const charging = model.ModelChargingInfo ?? [];
  if (charging.length) {
    rows.push([t("models.label.pricing"), ""]);
  }
  printAligned(rows);
  if (charging.length) {
    for (const group of charging) {
      // 阶梯计价必须先标出这是哪一档，否则多档的同名维度（两个「输入」）无从归属
      const label = tierLabel(group);
      if (label) {
        console.log(`  [${label}]`);
      }
      for (const item of group.ChargingItems ?? []) {
        const indent = label ? "    " : "  ";
        console.log(
          `${indent}${pad(item.DisplayName || item.PriceName, 10)} ${item.Price ?? ""} ${item.PriceUnit ?? ""}`,
        );
      }
    }
  }
}

async function pricingCommand(opts: Record<string, string>, globals: GlobalArgs): Promise<void> {
  const client = buildClient(globals);
  const params = buildListParams(opts);
  const resp = await client.call("DescribeModelList", params);
  const models = (resp["ModelSet"] as Model[] | undefined) ?? [];

  // 原始响应里 ModelChargingInfo 是分档数组、单位带货币，比拼好的 PRICING 文本完整
  if (emitJson(resp)) return;

  printTable(
    ["MODEL_ID", "NAME", "PRICING"],
    models.map((m) => {
      // 按分组拼，每组前面标出档位。不能把各档的条目平铺进一个列表：
      // 那样同名维度会重复出现，读的人无法判断某个价属于哪一档
      const groups: string[] = [];
      for (const group of m.ModelChargingInfo ?? []) {
        const items = (group.ChargingItems ?? []).map(
          (item) => `${item.DisplayName || item.PriceName}=${item.Price ?? ""}${item.PriceUnit ?? ""}`,
        );
        if (!items.length) {
          continue;
        }
        const label = tierLabel(group);
        groups.push(label ? `[${label}] ${items.join(" ")}` : items.join(" "));
      }
      return [m.ModelId ?? "", m.ModelName ?? "", groups.length ? groups.join(" ｜ ") : "-"];
    }),
  );
  console.log(summaryLine(resp["TotalCount"], models.length, params["Offset"]));
}

// =====================================================================
// models search：需求描述 → 候选推荐
//
// 云 API 无语义检索，DescribeModelList 只有 ModelType/Tags 等精确过滤。search 的
// 实现是「需求词 → 分类体系翻译器」：把自然语言里的词映射到真实的 Tags/Brand/
// ModelSpec 维度打分排序，输出附命中理由。结构化 flag 走硬过滤，query 走软打分。
// =====================================================================

/** 任务词典：需求词 → 命中的 Tags（基于真实数据里的 14 个能力标签） */
const TASK_LEXICON: Array<{ words: string[]; tags: string[]; label: string }> = [
  { words: ["深度思考", "推理", "思考", "数学", "证明", "逻辑", "代码"], tags: ["深度思考"], label: "深度思考" },
  { words: ["看图", "识图", "视觉", "图片理解", "图像理解", "ocr", "文字识别"], tags: ["视觉理解"], label: "视觉理解" },
  { words: ["画图", "文生图", "生成图片", "图片生成", "图像生成", "绘图"], tags: ["图片生成"], label: "图片生成" },
  { words: ["视频", "文生视频", "图生视频", "生成视频", "视频生成"], tags: ["视频生成"], label: "视频生成" },
  { words: ["语音转文字", "语音识别", "asr", "转写", "语音转文本"], tags: ["语音识别"], label: "语音识别" },
  { words: ["配音", "文字转语音", "tts", "语音合成", "读出来"], tags: ["语音合成", "AI配音"], label: "语音合成" },
  { words: ["音乐", "作曲", "歌曲", "bgm", "配乐"], tags: ["音乐生成"], label: "音乐生成" },
  { words: ["3d", "三维", "建模", "立体"], tags: ["3D生成"], label: "3D生成" },
  { words: ["向量", "检索", "embedding", "相似度", "语义匹配"], tags: ["文本向量", "多模态向量"], label: "向量检索" },
  { words: ["翻译", "中译英", "英译中"], tags: ["翻译"], label: "翻译" },
  { words: ["角色扮演", "人设", "角色", "扮演"], tags: ["角色扮演"], label: "角色扮演" },
  // 注意：不放裸"文本"——「长文本」「多模态文本」里的"文本"会误触发生成任务，
  // 干扰 longContext 等规格信号的判断
  { words: ["写作", "对话", "聊天", "问答", "文案"], tags: ["文本生成"], label: "文本生成" },
];

/** 厂商词典：需求词 → Brand（基于真实数据里的 15 个厂商）。
 * 注意：只放品牌名/厂商名，不放模型 ID 前缀——「hy3」「hy-」这类是模型名，应走
 * 文本模糊匹配精确命中单个模型，而不是被当成厂商过滤到整个品牌。 */
const BRAND_LEXICON: Array<{ words: string[]; brand: string }> = [
  { words: ["混元", "hunyuan", "腾讯"], brand: "混元" },
  { words: ["minimax", "mini max"], brand: "MiniMax" },
  { words: ["deepseek", "深度求索"], brand: "DeepSeek" },
  { words: ["可灵", "kling"], brand: "可灵" },
  { words: ["vidu"], brand: "Vidu" },
  { words: ["智谱", "glm", "zhipu", "清华"], brand: "智谱 AI" },
  { words: ["月之暗面", "kimi", "moonshot"], brand: "月之暗面" },
  { words: ["通义", "千问", "qwen", "阿里"], brand: "通义千问" },
  { words: ["优图", "youtu"], brand: "优图" },
  { words: ["pixverse"], brand: "pixverse" },
  { words: ["tripo"], brand: "Tripo" },
];

/** 规格排序信号：需求词 → 要优化的维度（便宜/长文本/长输出/高吞吐） */
const SPEC_WORDS = {
  // 注意：不含"免费"——免费额度是 FreeTrialInfo（见 STATE_WORDS），不是价格低
  cheap: ["便宜", "低价", "省钱", "性价比", "实惠"],
  longContext: ["长文本", "长上下文", "大窗口", "长文", "长文档", "上下文"],
  longOutput: ["长输出", "长文生成", "写长文", "长回答"],
  highThroughput: ["高并发", "高吞吐", "高tpm", "高qps", "并发"],
};

/** 状态词：需求词 → 免费额度 / 支持体验 */
const STATE_WORDS = {
  free: ["免费", "试用", "白嫖", "领取"],
  experience: ["体验"],
};

/**
 * 运行时能力维度：这些词描述的是网关层能力（联网搜索、函数调用/工具），
 * 直接当查询词打分会匹配到不准的标签或返回空，所以命中时给能力边界提示。
 *
 * 注意「联网搜索」如今确实有对应的模型标签（`--tags 联网搜索` 可筛出），
 * 所以它的提示文案要把这条查法给出来，而不是笼统说"无法按标签筛选"。
 */
const CAPABILITY_WORDS: Array<{ words: string[]; hintKey: string }> = [
  {
    words: ["联网", "搜索", "上网", "联网搜索"],
    hintKey: "models.capability.search",
  },
  {
    words: ["函数调用", "工具调用", "function", "tool", "插件"],
    hintKey: "models.capability.tools",
  },
];

/** 解析 "256k" / "192k" / "1m" 这类规格字符串成数字 */
function parseSize(value: unknown): number {
  const text = String(value ?? "").trim().toLowerCase();
  const match = /^([\d.]+)([kmb])?$/.exec(text);
  if (!match) return 0;
  const num = Number(match[1]);
  const unit = match[2];
  if (unit === "k") return num * 1000;
  if (unit === "m") return num * 1000000;
  if (unit === "b") return num * 1000000000;
  return num;
}

/** 提取模型的主要单价（元/百万tokens），取 Input 维度优先 */
function inputPriceItem(model: Model): { price: number; unit: string } | undefined {
  const order = ["Input", "TextInput", "ImageInput", "VideoInput", "Token"];
  for (const group of model.ModelChargingInfo ?? []) {
    for (const want of order) {
      const item = (group.ChargingItems ?? []).find((i) => i.PriceName === want);
      if (item?.Price) {
        const p = Number(item.Price);
        if (!Number.isNaN(p)) return { price: p, unit: item.PriceUnit ?? "" };
      }
    }
  }
  // fallback：没有标准 Input 维度（如 3D 模型只有 Output），取第一个有价格的维度，
  // 否则「便宜的 3D 生成」这类 query 会把它们全部误过滤掉
  for (const group of model.ModelChargingInfo ?? []) {
    for (const item of group.ChargingItems ?? []) {
      if (item?.Price) {
        const p = Number(item.Price);
        if (!Number.isNaN(p)) return { price: p, unit: item.PriceUnit ?? "" };
      }
    }
  }
  return undefined;
}

/** 只要价格数值的场景（过滤、打分）用这个 */
function inputPrice(model: Model): number | undefined {
  return inputPriceItem(model)?.price;
}

/** 提取模型上下文长度（数字） */
function contextLength(model: Model): number {
  return parseSize(model.ModelSpec?.["ContextLength"]);
}

/** 所有词典里出现过的词，query 里这些词已由词典处理，不再作为文本模糊匹配的 token */
const CONSUMED_WORDS = new Set<string>([
  ...TASK_LEXICON.flatMap((i) => i.words),
  ...BRAND_LEXICON.flatMap((i) => i.words),
  ...Object.values(SPEC_WORDS).flat(),
  ...Object.values(STATE_WORDS).flat(),
  ...CAPABILITY_WORDS.flatMap((i) => i.words),
].map((w) => w.toLowerCase()));

/** query 解析结果：任务/厂商是硬性要求，规格是排序信号，文本 token 做模糊匹配 */
interface ParsedQuery {
  /** 命中的任务标签（如 ["视频生成"]），非空时作为硬过滤条件 */
  taskTags: string[];
  /** 命中的任务中文名，用于输出 */
  taskLabels: string[];
  /** 命中的厂商，非空时作为硬过滤条件 */
  brand: string | undefined;
  wantCheap: boolean;
  wantLongCtx: boolean;
  wantLongOut: boolean;
  wantHigh: boolean;
  wantFree: boolean;
  wantExperience: boolean;
  /** 命中的运行时能力维度提示（联网/函数调用等，模型标签未覆盖） */
  capabilityHint: string | undefined;
  /** query 里的 ASCII token（如 deepseek、glm），用于文本模糊匹配 */
  asciiTokens: string[];
}

/** 把自然语言 query 解析成结构化意图：任务/厂商/规格/文本 token */
function parseQuery(query: string): ParsedQuery {
  const q = query.toLowerCase();
  const taskTags: string[] = [];
  const taskLabels: string[] = [];
  for (const item of TASK_LEXICON) {
    if (item.words.some((w) => q.includes(w))) {
      taskTags.push(...item.tags);
      taskLabels.push(item.label);
    }
  }
  let brand: string | undefined;
  for (const item of BRAND_LEXICON) {
    if (item.words.some((w) => q.includes(w))) {
      brand = item.brand;
      break;
    }
  }
  let capabilityHint: string | undefined;
  for (const item of CAPABILITY_WORDS) {
    if (item.words.some((w) => q.includes(w))) {
      capabilityHint = item.hintKey;
      break;
    }
  }
  return {
    taskTags,
    taskLabels,
    brand,
    wantCheap: SPEC_WORDS.cheap.some((w) => q.includes(w)),
    wantLongCtx: SPEC_WORDS.longContext.some((w) => q.includes(w)),
    wantLongOut: SPEC_WORDS.longOutput.some((w) => q.includes(w)),
    wantHigh: SPEC_WORDS.highThroughput.some((w) => q.includes(w)),
    wantFree: STATE_WORDS.free.some((w) => q.includes(w)),
    wantExperience: STATE_WORDS.experience.some((w) => q.includes(w)),
    capabilityHint,
    asciiTokens: q
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)
      .filter((t) => !CONSUMED_WORDS.has(t)),
  };
}

/** 文本模糊命中：模型名/系列/概要里含 query 的 ASCII token */
function textHitReasons(model: Model, parsed: ParsedQuery): string[] {
  const reasons: string[] = [];
  const text = [model.ModelName, model.DisplayName, model.ModelSeries, model.ModelId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const token of parsed.asciiTokens) {
    if (text.includes(token) && !reasons.includes(token)) {
      reasons.push(token);
    }
  }
  return reasons;
}

/** 硬过滤：结构化 flag 不满足即排除 */
function matchesFlags(model: Model, opts: Record<string, string>): boolean {
  if (opts["status"] && model.Status !== opts["status"]) return false;
  if (opts["brand"] && model.Brand !== opts["brand"]) return false;

  // --type 接受 ModelType 精确值或中文任务关键词（映射到 Tags）
  if (opts["type"]) {
    const want = opts["type"];
    const byType = model.ModelType === want;
    const byTag = (model.Tags ?? []).includes(want);
    // 中文关键词 → 找对应词典条目
    const taskHit = TASK_LEXICON.some(
      (item) => (item.words.includes(want) || item.label === want) && item.tags.some((t) => (model.Tags ?? []).includes(t)),
    );
    if (!byType && !byTag && !taskHit) return false;
  }

  if (opts["minContext"] !== undefined) {
    if (contextLength(model) < parseSize(opts["minContext"])) return false;
  }
  if (opts["maxInputPrice"] !== undefined) {
    const price = inputPrice(model);
    if (price === undefined || price > Number(opts["maxInputPrice"])) return false;
  }
  if (opts["freeTrial"] && !model.FreeTrialInfo) return false;
  if (opts["experience"] && !model.SupportExperience) return false;
  return true;
}

async function searchCommand(
  query: string | undefined,
  opts: Record<string, string>,
  globals: GlobalArgs,
): Promise<void> {
  const client = buildClient(globals);

  // 拉全量模型（一次 100，翻到拿完；平台共 106 个）
  const all: Model[] = [];
  for (let offset = 0; offset < 200; offset += 100) {
    const resp = await client.call("DescribeModelList", { Limit: 100, Offset: offset });
    const batch = (resp["ModelSet"] as Model[] | undefined) ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }

  // 结构化 flag 硬过滤
  const candidates = all.filter((m) => matchesFlags(m, opts));

  // 软打分 + 排序
  let ranked: Array<{ model: Model; score: number; reasons: string[] }>;
  if (query && query.trim()) {
    const parsed = parseQuery(query);

    // 任务词 / 厂商词是硬性要求：命中即过滤，而不是软加分。
    // 「混元的视频生成」必须同时满足 厂商=混元 且 标签含 视频生成，不能混入别的厂商。
    let scoped = candidates;
    if (parsed.brand) {
      scoped = scoped.filter((m) => m.Brand === parsed.brand);
    }
    if (parsed.taskTags.length) {
      scoped = scoped.filter((m) => (m.Tags ?? []).some((t) => parsed.taskTags.includes(t)));
    }
    // 规格词命中时，该规格成为硬性要求：没有对应规格的模型直接排除
    if (parsed.wantCheap) scoped = scoped.filter((m) => inputPrice(m) !== undefined);
    if (parsed.wantLongCtx) scoped = scoped.filter((m) => contextLength(m) > 0);
    if (parsed.wantLongOut) scoped = scoped.filter((m) => parseSize(m.ModelSpec?.["MaxOutputToken"]) > 0);

    // 打分：任务/厂商命中给基础分，规格归一化给排序分，文本 token 给附加分
    let scored = scoped.map((m) => {
      let score = 0;
      const reasons: string[] = [];
      const tags = m.Tags ?? [];
      if (parsed.taskLabels.length) {
        for (const label of parsed.taskLabels) {
          const item = TASK_LEXICON.find((x) => x.label === label);
          if (item && item.tags.some((t) => tags.includes(t))) {
            score += 10;
            reasons.push(label);
          }
        }
      }
      if (parsed.brand && m.Brand === parsed.brand) {
        score += 8;
        reasons.push(parsed.brand);
      }
      for (const r of textHitReasons(m, parsed)) {
        score += 5;
        reasons.push(r);
      }
      return { model: m, score, reasons };
    });

    // 规格排序信号：连续归一化（最多各 +5），让最便宜/最长上下文的排最前
    let maxPrice = 0;
    let maxCtx = 0;
    let maxOut = 0;
    for (const s of scored) {
      const p = inputPrice(s.model);
      if (p !== undefined) maxPrice = Math.max(maxPrice, p);
      maxCtx = Math.max(maxCtx, contextLength(s.model));
      maxOut = Math.max(maxOut, parseSize(s.model.ModelSpec?.["MaxOutputToken"]));
    }
    for (const s of scored) {
      if (parsed.wantCheap) {
        const p = inputPrice(s.model);
        if (p !== undefined && maxPrice > 0) s.score += 5 * (1 - p / maxPrice);
      }
      if (parsed.wantLongCtx && maxCtx > 0) {
        s.score += 5 * (contextLength(s.model) / maxCtx);
      }
      if (parsed.wantLongOut && maxOut > 0) {
        s.score += 5 * (parseSize(s.model.ModelSpec?.["MaxOutputToken"]) / maxOut);
      }
      if (parsed.wantHigh && parseSize(s.model.ModelSpec?.["TPM"]) > 0) s.score += 3;
      if (parsed.wantFree && s.model.FreeTrialInfo) {
        s.score += 3;
        s.reasons.push(t("models.search.reasonFree"));
      }
      if (parsed.wantExperience && s.model.SupportExperience) {
        s.score += 3;
        s.reasons.push(t("models.search.reasonExperience"));
      }
    }

    ranked = scored.filter((r) => r.score > 0);
    ranked.sort((a, b) => b.score - a.score || (a.model.RecommendWeight ?? 0) - (b.model.RecommendWeight ?? 0));
  } else {
    // 没给 query，纯结构化过滤时按推荐权重排序
    ranked = candidates
      .map((m) => ({ model: m, score: 0, reasons: [] as string[] }))
      .sort((a, b) => (a.model.RecommendWeight ?? 0) - (b.model.RecommendWeight ?? 0));
  }

  const limit = opts["limit"] !== undefined ? Number(opts["limit"]) : 10;
  const top = ranked.slice(0, limit);

  // 连命中原因一起给：这是本命令的核心产出（为什么推荐这个模型），
  // 只给模型列表会丢掉排序依据
  if (
    emitJson({
      Total: ranked.length,
      Models: top.map((r) => ({ ...r.model, MatchScore: r.score, MatchReasons: r.reasons })),
    })
  ) {
    return;
  }

  if (!top.length) {
    // 命中了运行时能力维度（联网/函数调用）时，给出针对性说明 + 下一步建议，
    // 而不是一句笼统的"没有匹配"——那会让用户误以为平台没有相关模型
    if (query && query.trim()) {
      const capabilityHint = parseQuery(query).capabilityHint;
      if (capabilityHint) {
        // capabilityHint 存的是文案键（见 CAPABILITY_WORDS.hintKey），必须过 t() 渲染。
        // 少了这一步会把 "models.capability.search" 这样的裸键名直接打给用户。
        console.log(t(capabilityHint));
        console.log(t("models.search.capabilityHint"));
        return;
      }
    }
    console.log(
      query ? t("models.search.noMatchQuery", { query }) : t("models.search.noMatch"),
    );
    return;
  }

  console.log(
    query
      ? t("models.search.foundQuery", { found: ranked.length, shown: top.length })
      : t("models.search.foundAll", { total: candidates.length, shown: top.length }),
  );
  console.log("");
  console.log(
    `${pad("#", 3)} ${pad("MODEL_ID", 18)} ${pad("BRAND", 8)} ${pad("TYPE", 10)} ${pad("CONTEXT", 8)} ${pad(t("models.search.col.inputPrice"), 20)} ${t("models.search.col.matched")}`,
  );
  top.forEach((r, i) => {
    // 价格连单位一起取：货币就在单位里（元 / 美元 / 积分），不能自己拼符号。
    // 各模型计价货币并不统一，写死任一符号都会让另一种货币的模型显示成错的价
    const priced = inputPriceItem(r.model);
    const ctx = contextLength(r.model);
    const ctxText = ctx > 0 ? `${ctx / 1000}k` : "-";
    const priceText = priced ? `${priced.price} ${priced.unit}`.trim() : "-";
    console.log(
      `${pad(String(i + 1).padStart(2, "0"), 3)} ${pad(r.model.ModelId, 18)} ${pad(r.model.Brand, 8)} ${pad(r.model.ModelType, 10)} ${pad(ctxText, 8)} ${pad(priceText, 20)} ${r.reasons.join("、") || "-"}`,
    );
  });

  if (query) {
    console.log("");
    console.log(t("models.search.footer"));
  }
}


/**
 * 免费包信息（模型列表的 FreeTrialInfo）。
 *
 * 实测字段只有额度大小/单位/有效期，**没有"是否已领取"的标志**——所以 all 只能按
 * "有免费包"筛，无法预先剔掉已领取的。重复领取由后端拒绝，故逐个调用并逐条报告
 * 失败原因，而不是让整批失败。
 */
interface FreeTrialInfo {
  CapacitySize?: number;
  Unit?: string;
  ValidityDays?: number;
}

/** 把 all / 逗号列表解析成模型 ID 集合；all 时用 picker 从全量里挑 */
async function resolveModelIds(
  raw: string | undefined,
  globals: GlobalArgs,
  picker: (models: Model[]) => Model[],
): Promise<{ ids: string[]; all: boolean }> {
  if (raw && raw.toLowerCase() !== "all") {
    return { ids: splitCsv(raw), all: false };
  }
  if (!raw) {
    return { ids: [], all: false };
  }
  // all：拉全量模型再按 picker 过滤，避免让用户手抄一长串 ID
  const models = await fetchAllModels(globals);
  return { ids: picker(models).map((m) => m.ModelId ?? "").filter(Boolean), all: true };
}

/** 端点的付费状态字段，用于算「哪些模型还没开按量付费」 */
interface EndpointPaymentState {
  ModelId?: string;
  PaymentEnabled?: boolean;
}

/** 分页拉全量端点，只为读 ModelId + PaymentEnabled */
async function fetchAllEndpointsForModels(
  client: ReturnType<typeof buildClient>,
): Promise<EndpointPaymentState[]> {
  const out: EndpointPaymentState[] = [];
  for (let offset = 0; ; offset += 99) {
    const resp = await client.call("DescribeModelEndpointList", { Limit: 99, Offset: offset });
    const page = (resp["ModelEndpointSet"] as EndpointPaymentState[] | undefined) ?? [];
    out.push(...page);
    const total = Number(resp["TotalCount"] ?? out.length);
    if (page.length < 99 || out.length >= total) {
      break;
    }
  }
  return out;
}

/** ID 列表太长时折叠，避免几十个名字铺满整屏、把后面的提示挤走 */
function summarizeIds(ids: string[], head = 6): string {
  if (ids.length <= head) {
    return ids.join(", ");
  }
  return t("common.andMore", { head: ids.slice(0, head).join(", "), count: ids.length });
}

/** 分页拉全量模型（接口上限 Limit=99） */
async function fetchAllModels(globals: GlobalArgs): Promise<Model[]> {
  const client = buildClient(globals);
  const out: Model[] = [];
  for (let offset = 0; ; offset += 99) {
    const resp = await client.call("DescribeModelList", { Limit: 99, Offset: offset });
    const page = (resp["ModelSet"] as Model[] | undefined) ?? [];
    out.push(...page);
    const total = Number(resp["TotalCount"] ?? out.length);
    if (page.length < 99 || out.length >= total) {
      break;
    }
  }
  return out;
}

/**
 * models free：领取模型免费额度。
 *
 * 接口只需 ModelIds（实测传不存在的 ID 会返回 model not found，说明无其它必填项）。
 * all 时只挑「有免费包且尚未领取」的，避免对已领取的模型重复请求换来一堆报错。
 */
async function freeCommand(
  target: string | undefined,
  opts: { yes?: boolean; dryRun?: boolean },
  globals: GlobalArgs,
): Promise<void> {
  if (!target) {
    console.log(t("models.free.noTarget"));
    return;
  }

  console.log(t("models.free.resolving"));
  const catalog = await fetchAllModels(globals);
  const withFree = new Map(
    catalog
      .filter((m) => (m as { FreeTrialInfo?: FreeTrialInfo }).FreeTrialInfo !== undefined)
      .map((m) => [m.ModelId ?? "", m]),
  );

  let ids: string[];
  if (target.toLowerCase() === "all") {
    ids = [...withFree.keys()].filter(Boolean);
  } else {
    // 先本地校验再发请求：端点上的 ModelId 不一定存在于模型库
    // （实测 custom-model-a2 有端点但不在模型库里，直接发请求只会换回
    // "model not found"，那对用户毫无指导意义）
    const asked = splitCsv(target);
    const unknown = asked.filter((id) => !catalog.some((m) => m.ModelId === id));
    const noFree = asked.filter((id) => !unknown.includes(id) && !withFree.has(id));
    if (unknown.length) {
      console.log(t("models.free.unknown", { names: unknown.join(", ") }));
    }
    if (noFree.length) {
      console.log(t("models.free.noFreePackage", { names: noFree.join(", ") }));
    }
    ids = asked.filter((id) => withFree.has(id));
  }

  if (!ids.length) {
    console.log(t("models.free.nothing"));
    return;
  }

  console.log(t("models.free.plan", { count: ids.length, names: summarizeIds(ids) }));
  if (opts.dryRun) {
    console.log(t("billing.dryRun"));
    return;
  }
  if (!(await confirm(t("billing.confirmPrompt"), opts.yes))) {
    console.log(t("billing.aborted"));
    return;
  }

  // 逐个领取而非一次传全部：单个模型失败不该让整批回滚，且能逐条报告原因
  const client = buildClient(globals);
  const failures: Array<{ model: string; reason: string }> = [];
  for (const id of ids) {
    try {
      await client.call("CreateFreeTrialPackage", { ModelIds: [id] });
    } catch (err) {
      failures.push({ model: id, reason: (err as Error).message });
    }
  }

  const ok = ids.length - failures.length;

  // 逐个模型开通、可能部分失败，所以结构里要带上成败明细
  if (emitJson({ Requested: ids.length, Succeeded: ok, Failures: failures })) return;

  if (failures.length) {
    console.log(t("models.free.partial", { ok, failed: failures.length }));
    for (const f of failures) {
      console.log(t("models.free.itemFail", f));
    }
  } else {
    console.log(t("models.free.ok", { count: ok }));
  }
  if (ok > 0) {
    console.log(t("models.free.next"));
  }
}

/**
 * models activate：开启模型的按量付费。
 *
 * 接口是 ModifyPaymentStateBatch(ModelIds, PaymentEnabled)——按模型批量开，
 * 不需要先有端点（另一个 ModifyPaymentState 才是按 EndpointId 的单个操作）。
 */
async function activateCommand(
  target: string | undefined,
  opts: { yes?: boolean; dryRun?: boolean },
  globals: GlobalArgs,
): Promise<void> {
  if (!target) {
    console.log(t("models.activate.noTarget"));
    return;
  }

  // 「是否已开按量付费」在端点上（PaymentEnabled），模型列表里没有这个字段——
  // 之前按模型筛导致 all 选中了全部 110 个模型，会让用户一次性开通所有计费。
  // 故 all 改为从端点侧算：有端点且全部未开后付费的模型才是待开通的。
  const client = buildClient(globals);
  let ids: string[];
  if (target.toLowerCase() === "all") {
    const endpoints = await fetchAllEndpointsForModels(client);
    const byModel = new Map<string, boolean>();
    for (const e of endpoints) {
      const model = e.ModelId ?? "";
      if (!model) {
        continue;
      }
      // 任一端点已开，就认为该模型已开通
      byModel.set(model, (byModel.get(model) ?? false) || e.PaymentEnabled === true);
    }
    ids = [...byModel.entries()].filter(([, enabled]) => !enabled).map(([model]) => model);
  } else {
    ids = splitCsv(target);
  }

  if (!ids.length) {
    console.log(t("models.activate.nothing"));
    return;
  }

  console.log(t("models.activate.plan", { count: ids.length, names: summarizeIds(ids) }));
  console.log(t("models.activate.billingWarn"));
  if (opts.dryRun) {
    console.log(t("billing.dryRun"));
    return;
  }
  if (!(await confirm(t("billing.confirmPrompt"), opts.yes))) {
    console.log(t("billing.aborted"));
    return;
  }

  const resp = await client.call("ModifyPaymentStateBatch", { ModelIds: ids, PaymentEnabled: true });
  if (emitJson({ ...resp, ModelIds: ids })) return;
  console.log(t("models.activate.ok", { count: ids.length }));
}


/** compare 一次最多几个模型。再多终端列宽就挤不下 */
const COMPARE_MAX = 4;

/**
 * models compare：横向对比多个模型。
 *
 * 用「字段为行、模型为列」的转置布局，而不是每个模型一段——对比时眼睛要横向扫
 * 同一字段，纵向排列反而要来回翻。列宽按各列最长内容自适应。
 */
async function compareCommand(target: string | undefined, globals: GlobalArgs): Promise<void> {
  if (!target) {
    console.log(t("models.compare.needIds"));
    return;
  }
  const ids = splitCsv(target);
  if (ids.length > COMPARE_MAX) {
    console.log(t("models.compare.tooMany", { max: COMPARE_MAX, count: ids.length }));
    return;
  }

  const catalog = await fetchAllModels(globals);
  const found = ids
    .map((id) => catalog.find((m) => m.ModelId === id))
    .filter((m): m is Model => m !== undefined);
  const missing = ids.filter((id) => !catalog.some((m) => m.ModelId === id));

  // 缺失的 ID 也要给出来：文本模式是单独一行提示，JSON 里得是字段，
  // 否则调用方只看到少了几个模型、不知道是哪几个没找到
  if (emitJson({ Models: found, NotFound: missing })) return;

  if (missing.length) {
    console.log(t("models.compare.notFound", { names: missing.join(", ") }));
  }
  if (!found.length) {
    console.log(t("models.compare.noneFound"));
    return;
  }

  const freeTrialText = (model: Model): string => {
    const info = (model as { FreeTrialInfo?: FreeTrialInfo }).FreeTrialInfo;
    if (!info) {
      return "-";
    }
    return t("models.compare.freeTrialValue", {
      size: human(Number(info.CapacitySize ?? 0)),
      unit: info.Unit ?? "",
      days: info.ValidityDays ?? "-",
    });
  };

  // 每行一个字段，取值函数从模型里读
  const fields: Array<[string, (m: Model) => string]> = [
    [t("models.compare.row.name"), (m) => m.ModelName ?? "-"],
    [t("models.compare.row.type"), (m) => m.ModelType ?? "-"],
    [t("models.compare.row.brand"), (m) => m.Brand || "-"],
    [t("models.compare.row.status"), (m) => m.Status ?? "-"],
    [t("models.compare.row.context"), (m) => String(m.ModelSpec?.["ContextLength"] ?? "-")],
    [t("models.compare.row.maxInput"), (m) => String(m.ModelSpec?.["MaxInputToken"] ?? "-")],
    [t("models.compare.row.maxOutput"), (m) => String(m.ModelSpec?.["MaxOutputToken"] ?? "-")],
    [t("models.compare.row.tpm"), (m) => String(m.ModelSpec?.["TPM"] ?? "-")],
    [t("models.compare.row.qpm"), (m) => String(m.ModelSpec?.["QPM"] ?? "-")],
    [t("models.compare.row.freeTrial"), freeTrialText],
    [t("models.compare.row.tags"), (m) => (m.Tags ?? []).join(",") || "-"],
  ];

  // 计费项按「档位 + 维度」并集补行——各模型的计费维度不同（3D 模型只有 Output），
  // 用并集才能看出"这个模型没有该维度"。
  //
  // 键里必须含档位：只用维度名的话，阶梯计价的两个「输入」会被去重成一行，取值时
  // 又只返回第一个匹配项，于是第二档整档被悄悄丢掉，横向比价看到的是错的价。
  const priceKeys: Array<{ key: string; tier: string; dimension: string }> = [];
  for (const model of found) {
    for (const group of model.ModelChargingInfo ?? []) {
      const tier = tierLabel(group);
      for (const item of group.ChargingItems ?? []) {
        const dimension = item.DisplayName || item.PriceName;
        if (!dimension) {
          continue;
        }
        const key = tier ? `${dimension} [${tier}]` : dimension;
        if (!priceKeys.some((p) => p.key === key)) {
          priceKeys.push({ key, tier, dimension });
        }
      }
    }
  }
  for (const { key, tier, dimension } of priceKeys) {
    fields.push([
      key,
      (m) => {
        for (const group of m.ModelChargingInfo ?? []) {
          if (tierLabel(group) !== tier) {
            continue;
          }
          for (const item of group.ChargingItems ?? []) {
            if ((item.DisplayName || item.PriceName) === dimension) {
              return `${item.Price ?? "-"} ${item.PriceUnit ?? ""}`.trim();
            }
          }
        }
        return "-";
      },
    ]);
  }

  // 列宽自适应：标签列取最长字段名，各模型列取该列最长内容（含表头）
  const labelWidth = Math.max(...fields.map(([label]) => displayWidth(label)));
  const colWidths = found.map((model, index) =>
    Math.max(
      displayWidth(model.ModelId ?? ""),
      ...fields.map(([, get]) => displayWidth(get(found[index] as Model))),
    ),
  );

  const header = found
    .map((model, i) => pad(model.ModelId ?? "", colWidths[i] as number))
    .join("  ");
  console.log(`${pad("", labelWidth)}  ${header}`);
  for (const [label, get] of fields) {
    const cells = found.map((model, i) => pad(get(model), colWidths[i] as number)).join("  ");
    console.log(`${pad(label, labelWidth)}  ${cells}`);
  }
  console.log("");
  console.log(t("models.compare.footer"));
}

/** 装配 models 命令组 */
export function registerModelCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const models = program.command("models").description(t("group.models.desc"));

  const filterOptions = (cmd: Command): Command =>
    cmd
      .option("--type <types>", t("models.opt.type"))
      .option("--ids <ids>", t("models.opt.ids"))
      .option("--names <names>", t("models.opt.names"))
      .option("--tags <tags>", t("models.opt.tags"))
      .option("--limit <n>", t("opt.limit"))
      .option("--offset <n>", t("opt.offset"));

  filterOptions(models.command("list").description(t("models.list.desc"))).action(async (opts) =>
    listCommand(opts, getGlobals()),
  );

  models
    .command("get")
    .description(t("models.get.desc"))
    .requiredOption("--id <id>", "ModelId")
    .action(async (opts) => getCommand(opts, getGlobals()));

  models
    .command("compare")
    .description(t("models.compare.desc"))
    .argument("[models]", t("models.compare.arg"))
    .action(async (target: string | undefined) => compareCommand(target, getGlobals()));

  models
    .command("free")
    .description(t("models.free.desc"))
    .argument("[models]", t("models.free.argModels"))
    .option("--yes", t("opt.yes"))
    .option("--dry-run", t("opt.dryRun"))
    .action(async (target: string | undefined, opts: { yes?: boolean; dryRun?: boolean }) =>
      freeCommand(target, opts, getGlobals()),
    );

  models
    .command("activate")
    .description(t("models.activate.desc"))
    .argument("[models]", t("models.activate.argModels"))
    .option("--yes", t("opt.yes"))
    .option("--dry-run", t("opt.dryRun"))
    .action(async (target: string | undefined, opts: { yes?: boolean; dryRun?: boolean }) =>
      activateCommand(target, opts, getGlobals()),
    );

  filterOptions(models.command("pricing").description(t("models.pricing.desc"))).action(async (opts) =>
    pricingCommand(opts, getGlobals()),
  );

  models
    .command("search")
    .description(t("models.search.desc"))
    .argument("[query]", t("models.search.arg"))
    .option("--type <type>", t("models.search.opt.type"))
    .option("--brand <brand>", t("models.search.opt.brand"))
    .option("--status <status>", t("models.search.opt.status"))
    .option("--min-context <n>", t("models.search.opt.minContext"))
    .option("--max-input-price <n>", t("models.search.opt.maxInputPrice"))
    .option("--free-trial", t("models.search.opt.freeTrial"))
    .option("--experience", t("models.search.opt.experience"))
    .option("--limit <n>", t("opt.limit"), "10")
    .action(async (query: string | undefined, opts: Record<string, string>) =>
      searchCommand(query, opts, getGlobals()),
    );
}
