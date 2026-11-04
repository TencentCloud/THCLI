/**
 * 由接口注册表生成两类文档，改了注册表后重跑：
 *   npx tsc -p tsconfig.test.json && node dist-test/test/gen/generate.js
 *
 * 1. test/gen/catalog.md：+gen 用例目录。用例清单跟着注册表走：每个接口的每个字段至少一条正向用例
 *    （字段进请求体），必填 / 适用模型 / 只收 URL 各一条校验用例。
 * 2. skills/thcli-{image,video,world,audio}/SKILL.md 里 <!-- apis:begin --> … <!-- apis:end -->
 *    之间的「接口参数」章节。skills/ 不在仓库里（.gitignore），目录不存在时跳过。
 */
import fs from "node:fs";
import path from "node:path";

import {
  APIS,
  type ApiRef,
  isRequired,
  type MediaKind,
  type MediaSpec,
  type ParamField,
  type ParamSpec,
  paramUsage,
} from "../../src/core/gen-registry.js";

const OUT = path.join(process.cwd(), "test", "gen", "catalog.md");
const KIND_TITLE: Record<MediaKind, string> = { image: "图像", video: "视频", "3d": "3D", audio: "语音" };

/** 真实素材（test/assets）：本地路径相对 test/gen，URL 为同一素材在 COS 上的副本（run.sh --sync-assets 上传） */
const ASSET_URL = "https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets";
const L = (f: string) => `../assets/${f}`;
const U = (f: string) => `${ASSET_URL}/${f}`;
const IMG = "images/cat-window.jpg";
const FACE = "images/portrait.jpg";
const WAV = "audio/speech-zh-10s.wav";
const VID = "videos/dance-8s.mp4";

/** media 归一化成数组（ParamSpec.media 可为数组：不同子路径不同规则） */
function mediaSpecs(p: ParamSpec): MediaSpec[] {
  return p.media ? (Array.isArray(p.media) ? p.media : [p.media]) : [];
}

/** 本地文件样例：图片字段用 cat-window.jpg；音视频字段按接口给中文语音 / 配音视频 */
function localSample(p: ParamSpec): string {
  if (mediaSpecs(p).find((m) => m.encoding !== "urlOnly")?.type !== "media") return L(IMG);
  return p.path === "input_url" ? L("videos/dub-video.mp4") : L(WAV);
}

/** 字段示例值（命令行写法） */
function sampleOf(p: ParamSpec): string {
  if (p.kind === "array") {
    if (!p.fields?.length) return p.media ? `'["${p.path === "videos" ? U(VID) : U(IMG)}"]'` : `'["pop"]'`;
    return `'[{${sampleFields(p.fields)}}]'`;
  }
  if (p.kind === "object") return `'{${sampleFields(p.fields ?? [])}}'`;
  if (SAMPLE[p.path] && !p.choices) return SAMPLE[p.path]!;
  if (p.choices) return String(p.choices[0]);
  if (p.valueType === "boolean") return "true";
  if (p.valueType === "number") return "1";
  {
    const specs = mediaSpecs(p);
    if (specs.length) {
      const local = specs.find((m) => m.encoding !== "urlOnly");
      if (!local) {
        const first = specs[0]!;
        return first.type === "image" ? U(IMG) : p.path === "input_url" ? U("videos/dub-video.mp4") : U(WAV);
      }
      return localSample(p);
    }
  }
  return p.path === "prompt" || p.path === "text" ? "猫" : "x";
}

function sampleFields(fields: ParamField[]): string {
  const pick = fields.filter((f) => f.required).length ? fields.filter((f) => f.required) : fields.slice(0, 1);
  return pick
    .map((f) => {
      if (f.type === "object") return `"${f.key}":{${sampleFields(f.fields ?? [])}}`;
      if (f.type === "array") return `"${f.key}":[${f.fields?.length ? `{${sampleFields(f.fields)}}` : `"${U(IMG)}"`}]`;
      if (f.choices) return `"${f.key}":${JSON.stringify(f.choices[0])}`;
      if (f.type === "boolean") return `"${f.key}":true`;
      if (f.type === "integer" || f.type === "number") return `"${f.key}":${f.min ?? 1}`;
      return `"${f.key}":"x"`;
    })
    .join(",");
}

/** 条件必填（二选一 / 至少一个）的最小输入，按接口补齐 */
const BASELINE: Record<string, string[]> = {
  "wand/hunyuan-video/generation": ["--prompt 猫"],
  "api/3d/submit": ["--prompt 狗"],
  "wand/hunyuan-video/world2-scene": ["--prompt 场景"],
  "wand/asrproxy/sync_transcribe": [`--input-url ${U(WAV)}`],
  "wand/minimax-tts/sync_clone": [`--audio-url ${U("audio/ref6s.mp3")}`],
  "wand/minimax-music/generation": ["--lyrics '[Verse] 歌词'"],
  "wand/minimax-video/generation": ["--prompt 猫"],
  "wand/minimax-video-v2/generation": ["--ratio 16:9"],
  "wand/vidu/reference-to-video": [`--images ${L(FACE)}`],
};

/** 结构有块级约束的必填字段：给出可直接使用的合法值（接口 → 字段 → 值） */
const REQUIRED_SAMPLE: Record<string, Record<string, string>> = {
  "wand/kling/image-to-video": { contents: `'[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"${L(IMG)}"}]'` },
  "wand/kling/omni-video": { contents: `'[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"${L(IMG)}"}]'` },
  "wand/kling/motion-control": {
    contents: `'[{"type":"image","url":"${U(FACE)}"},{"type":"video","url":"${U(VID)}"}]'`,
    settings: `'{"character_orientation":"image"}'`,
  },
  "wand/minimax-video-v2/generation": { content: `'[{"type":"text","text":"猫"}]'`, resolution: "768P", duration: "6" },
  "wand/vega-videos/tasks": { content: `'[{"type":"text","text":"猫"}]'` },
  "wand/hunyuan-image/v35-generation": { messages: `'[{"role":"user","content":[{"type":"text","text":"猫"}]}]'` },
  "wand/minimax-tts/sync_tts": { voice_setting: `'{"voice_id":"male-qn-qingse"}'` },
};

/** 接口的最小合法调用（必填字段齐全） */
function baseArgs(e: ApiRef, model: string): string[] {
  const args = [`thcli +gen ${e.id}`];
  if (e.models.length > 1) args.push(`--model ${model}`);
  for (const p of e.params) {
    if (isRequired(p, model)) args.push(`--${p.flag} ${REQUIRED_SAMPLE[e.id]?.[p.path] ?? sampleOf(p)}`);
  }
  args.push(...(BASELINE[e.id] ?? []));
  return args;
}

/** 把 extra 加到基线上；同名 flag 以 extra 为准（避免二选一字段重复 / 冲突） */
function withFlag(e: ApiRef, model: string, flag: string, value: string): string {
  const conflicts = EXCLUSIVE[e.id]?.find((g) => g.includes(flag)) ?? [flag];
  const base = baseArgs(e, model).filter((a) => !conflicts.some((c) => a.startsWith(`--${c} `)));
  return [...base, `--${flag} ${value}`].join(" ");
}

/** 互斥字段组：换上其中一个时去掉基线里的另一个 */
const EXCLUSIVE: Record<string, string[][]> = {
  "wand/hunyuan-video/generation": [["prompt", "image", "image-url"]],
  "api/3d/submit": [["prompt", "image-base64", "image-url"]],
  "wand/hunyuan-video/world2-scene": [["prompt", "image-url"]],
  "wand/asrproxy/sync_transcribe": [["input-url", "data"]],
  "wand/minimax-tts/sync_clone": [["audio-url", "audio-data"]],
  "wand/vidu/reference-to-video": [["images", "subjects", "videos"]],
};

function rowsOf(e: ApiRef, prefix: string): string[] {
  const model = e.models[0]!;
  const base = baseArgs(e, model).join(" ");
  const rows: string[] = [];
  let n = 1;
  const id = () => `${prefix}-${String(n++).padStart(2, "0")}`;
  rows.push(`| ${id()} | 最小调用 | \`${base}\` | 必填字段 | 请求体含全部必填字段 |`);
  for (const p of e.params) {
    if (isRequired(p, model)) continue;
    const m = p.models && !p.models.includes(model) ? p.models[0]! : model;
    const call = withFlag(e, m, p.flag, sampleOf(p));
    rows.push(`| ${id()} | --${p.flag} | \`${call}\` | ${p.path} | 请求体含 ${p.path} |`);
  }
  for (const p of e.params) {
    if (isRequired(p, model)) {
      const call = baseArgs(e, model).filter((a) => !a.startsWith(`--${p.flag} `)).join(" ");
      rows.push(`| ${id()} | 缺 --${p.flag} | \`${call}\` | 必填校验 | 本地报「--${p.flag} 必填」 |`);
    }
  }
  for (const p of e.params) {
    const other = p.models ? e.models.find((x) => !p.models!.includes(x)) : undefined;
    if (other) {
      const call = withFlag(e, other, p.flag, sampleOf(p));
      rows.push(`| ${id()} | ${other} 传 --${p.flag} | \`${call}\` | 适用模型 | 本地报「仅 ${p.models!.join(" / ")} 支持」 |`);
    }
  }
  for (const p of e.params) {
    const specs = mediaSpecs(p);
    if (specs.length && specs.every((m) => m.encoding === "urlOnly")) {
      const call = withFlag(e, model, p.flag, p.kind === "value" ? localSample(p) : "<含本地路径的 JSON>");
      rows.push(`| ${id()} | --${p.flag} 本地文件 | \`${call}\` | 只收 URL | 本地报「只收公网 URL」 |`);
      break;
    }
  }
  return rows;
}

const KIND_PREFIX: Record<MediaKind, string> = { image: "img", video: "vid", "3d": "3d", audio: "aud" };
const prefixOf = (e: ApiRef) => `${KIND_PREFIX[e.kind]}-${e.id.split("/").slice(1).join("-").replace(/[^a-z0-9-]/gi, "")}`;

/** 常见字段的可读示例值 */
const SAMPLE: Record<string, string> = {
  size: "1024x1024",
  aspect_ratio: "16:9",
  ratio: "16:9",
  seed: "42",
  duration: "5",
  n: "2",
  footnote: "水印",
  callback_url: "https://example.com/cb", // 回调地址无需真实素材
  wm_url: U("images/sneaker.png"),
  session: "sess-001",
  voice_id: "custom_001",
  tts_model: "minimax-speech-2.8-turbo",
  preview_text: "你好",
  lyrics: "'[Verse] 歌词'",
  source: "zh",
  src_language: "zh",
  dst_language: "en",
  language_boost: "auto",
  camera_movement: "zoom_in",
  payload: "x",
  accuracy: "0.8",
  series_amount: "4",
};

// ── 1. 用例目录：四类合成一份，先总矩阵、再按类别列接口矩阵与逐接口用例
const kinds = Object.keys(KIND_TITLE) as MediaKind[];
const byKind = kinds.map((kind) => {
  const eps = APIS.filter((e) => e.kind === kind);
  return { kind, eps, rows: eps.map((e) => rowsOf(e, prefixOf(e))) };
});
const total = (k: (typeof byKind)[number]) => k.rows.reduce((n, r) => n + r.length, 0);
const anchor = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5 -]/g, "").replace(/ /g, "-");
const out: string[] = ["# +gen 用例目录", ""];
out.push("> 由 `test/gen/generate.ts` 按接口注册表生成，勿手改；参数 = 官方接口请求体字段，flag 名即字段名（下划线换连字符）。");
out.push(
  "> 数组传 JSON 数组（字符串数组也可直接给单个值），对象传 JSON 对象；素材全部来自 `test/assets`：`../assets/...` 为本地文件（自动编码），`" +
    ASSET_URL +
    "/...` 为同一素材的公网副本（只收 URL 的字段用）。",
  "",
);
out.push("| 类别 | 接口数 | 用例数 |", "|---|---|---|");
for (const k of byKind) out.push(`| [${KIND_TITLE[k.kind]}](#${anchor(KIND_TITLE[k.kind])}) | ${k.eps.length} | ${total(k)} |`);
out.push(`| **合计** | **${APIS.length}** | **${byKind.reduce((n, k) => n + total(k), 0)}** |`, "");
for (const k of byKind) {
  out.push(`## ${KIND_TITLE[k.kind]}`, "", "| 接口 | 模型 | 字段（* 必填） | 用例数 |", "|---|---|---|---|");
  k.eps.forEach((e, i) => {
    const flags = e.params.map((p) => `${isRequired(p) ? "*" : ""}--${p.flag}`).join(" ");
    out.push(`| [${e.id}](#${anchor(e.id)}) | ${e.models.join(" / ")} | ${flags} | ${k.rows[i]!.length} |`);
  });
  out.push("");
  k.eps.forEach((e, i) => out.push(`### ${e.id}`, "", "| ID | 场景 | 命令 | 覆盖 | 预期 |", "|---|---|---|---|---|", ...k.rows[i]!, ""));
}
fs.writeFileSync(OUT, `${out.join("\n").trimEnd()}\n`);
console.log(`catalog.md: ${APIS.length} apis, ${byKind.reduce((n, k) => n + total(k), 0)} cases`);

// ── 2. skill 文档的「接口参数」章节
const SKILLS = process.env.SKILLS_DIR ?? path.join(process.cwd(), "skills");
const SKILL_DIR: Record<MediaKind, string> = { image: "thcli-image", video: "thcli-video", "3d": "thcli-3d", audio: "thcli-audio" };
const BEGIN = "<!-- apis:begin -->";
const END = "<!-- apis:end -->";
const esc = (s: string) => s.replace(/\|/g, "\\|");

function noteOf(p: ParamSpec): string {
  const notes: string[] = [];
  if (p.required === true) notes.push("**必填**");
  else if (Array.isArray(p.required)) notes.push(`**${p.required.join(" / ")} 必填**`);
  if (p.default !== undefined && typeof p.default !== "function") notes.push(`**默认 ${String(p.default)}**`);
  if (p.models) notes.push(`仅 ${p.models.join(" / ")}`);
  {
    const specs = mediaSpecs(p);
    if (specs.length) notes.push(specs.some((m) => m.encoding !== "urlOnly") ? "可传本地文件" : "仅公网 URL");
  }
  return notes.join("；");
}

function skillSection(e: ApiRef): string[] {
  const lines = [`### \`${e.id}\``, ""];
  lines.push(`模型：${e.models.map((m) => `\`${m}\``).join("、")}（${e.sync ? "同步" : "异步"}）`);
  if (e.modelNote) lines.push("", `> ${e.modelNote.zh}`);
  lines.push("", "| 参数 | 说明 | 约束 |", "|---|---|---|");
  for (const p of e.params) lines.push(`| \`${esc(paramUsage(p))}\` | ${esc(p.desc.zh)} | ${esc(noteOf(p))} |`);
  return [...lines, ""];
}

if (!fs.existsSync(SKILLS)) {
  console.log(`skills/ 不存在（${SKILLS}），跳过 SKILL.md 接口参数章节；skills 已迁移为独立仓库时用 SKILLS_DIR=<路径> 指定`);
} else {
  for (const { kind, eps } of byKind) {
    const file = path.join(SKILLS, SKILL_DIR[kind], "SKILL.md");
    const src = fs.readFileSync(file, "utf8");
    const s = src.indexOf(BEGIN);
    const e = src.indexOf(END);
    if (s < 0 || e < 0) throw new Error(`${file} 缺少 ${BEGIN} / ${END} 标记`);
    fs.writeFileSync(file, `${src.slice(0, s + BEGIN.length)}\n\n${eps.flatMap(skillSection).join("\n")}\n${src.slice(e)}`);
    console.log(`${SKILL_DIR[kind]}/SKILL.md: ${eps.length} apis`);
  }
}
