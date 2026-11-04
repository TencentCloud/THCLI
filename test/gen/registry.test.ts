/**
 * +gen 接口注册表：字段契约、请求体校验、参数解析、本地文件编码、响应归一化、--param / --body 覆盖层。
 *
 * +gen 按接口组织：接口参数 = 官方接口请求体顶层字段，flag 名即字段名（下划线换连字符）。
 * 这里把官方调用指南（tools/文档参数表.xlsx）当作契约：每个接口的字段清单、必填、适用模型都要对上；
 * 文档示例的响应要能被正确归一化。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { deepMerge } from "../../src/core/config.js";
import { initLang } from "../../src/core/i18n.js";
import {
  checkBody,
  APIS,
  apiOf,
  apiSupportsModel,
  FAMILIES,
  familyOf,
  mapMedia,
  type MediaSpec,
  paramHelpText,
  paramUsage,
  parseParams,
  parseParamValue,
  parseResponse,
} from "../../src/core/gen-registry.js";

// 校验文案走 locales：本文件按英文断言（node --test 每个文件独立进程，不影响其他文件）；中文另有专门用例
initLang("en");

const ep = (id: string) => apiOf(id)!;
const fields = (id: string) => ep(id).params.map((p) => p.path);
const param = (id: string, field: string) => ep(id).params.find((p) => p.path === field)!;
/** 单数 media 收窄（media 可为数组：不同子路径不同规则；数组取第一条） */
const single = (id: string, field: string): MediaSpec => {
  const media = param(id, field).media;
  return (Array.isArray(media) ? media[0] : media)!;
};

describe("注册表完整性", () => {
  it("模型 ID 全局唯一，异步族都有 taskIdOf 与 query", () => {
    const seen = new Set<string>();
    for (const f of FAMILIES) {
      for (const m of f.models) {
        assert.ok(!seen.has(m), `重复的模型 ${m}`);
        seen.add(m);
      }
      if (!f.sync) assert.ok(f.taskIdOf && f.query, f.id);
    }
  });

  it("每个族都声明了官方调用指南；接口 ID 唯一且提交路径正确", () => {
    for (const f of FAMILIES) {
      for (const d of [f.doc].flat()) assert.match(d, /^https:\/\/cloud\.tencent\.com\/document\/product\/1823\/\d+$/, `${f.id} ${d}`);
    }
    assert.equal(APIS.length, 36);
    assert.equal(new Set(APIS.map((e) => e.id)).size, APIS.length);
    assert.equal(ep("wand/vidu/text-to-video").path, "/v1/wand/vidu/text-to-video");
    assert.equal(ep("api/3d/submit").path, "/v1/api/3d/submit");
  });

  it("flag 名 = 字段名下划线换连字符；接口内无重复字段；不再有 model 之外的公共参数", () => {
    for (const e of APIS) {
      const seen = new Set<string>();
      for (const p of e.params) {
        assert.equal(p.flag, p.path.replace(/_/g, "-"), `${e.id} ${p.path}`);
        assert.ok(!seen.has(p.path), `${e.id} 重复字段 ${p.path}`);
        assert.notEqual(p.path, "model", `${e.id} model 由 --model 统一传`);
        seen.add(p.path);
      }
    }
  });

  it("默认值声明合法：仅 value 类字段可设，类型与 valueType 一致，值在 choices 内，且不限定 models", () => {
    for (const e of APIS) {
      for (const p of e.params) {
        if (p.default === undefined) continue;
        assert.equal(p.kind, "value", `${e.id} --${p.flag}：object/array 字段不支持默认值`);
        if (typeof p.default === "function") continue; // 条件默认值（如 sync_tts 流式不注入 url）无静态值可断言
        if (p.valueType) assert.equal(typeof p.default, p.valueType, `${e.id} --${p.flag}：默认值类型应与 valueType 一致`);
        else assert.ok(typeof p.default === "string" || typeof p.default === "number", `${e.id} --${p.flag}：智能标量的默认值只能是 string/number`);
        if (p.choices) assert.ok(p.choices.some((c) => c === p.default), `${e.id} --${p.flag}：默认值须在 choices 内`);
        // apiFlagValues 注入 default 时不校验模型适配：带 models 的字段会让不适用的模型「没传却报错」（checkBody 拦截）
        assert.ok(!p.models, `${e.id} --${p.flag}：default 字段不得限定 models——需按模型分派默认值时，先让注入挪到 model 确定之后`);
      }
    }
  });

  it("接口字段清单与官方调用指南一致（防漏参 / 防多参）", () => {
    const cases: Array<[string, string[]]> = [
      ["wand/hunyuan-image/v3-generation", ["prompt", "images", "size", "seed", "footnote", "revise"]],
      ["wand/hunyuan-image/v35-generation", ["messages", "size", "seed", "generate_max_pixels", "resize_max_pixels", "session", "footnote", "use_search_tool"]],
      ["wand/si-image/generation", ["prompt", "images", "size", "layer_decomposition", "optimize_prompt_options", "output_format", "background", "response_format", "sequential_image_generation", "sequential_image_generation_options", "tools", "watermark"]],
      ["wand/vega-images/generations", ["prompt", "input", "size"]],
      ["wand/vidu-image/generation", ["prompt", "images", "aspect_ratio", "resolution", "seed", "callback_url"]],
      ["wand/kling-image/generation", ["prompt", "negative_prompt", "image", "image_list", "element_list", "aspect_ratio", "resolution", "n", "watermark_info", "result_type", "series_amount"]],
      ["wand/hunyuan-video/generation", ["prompt", "negative_prompt", "image", "image_url", "n", "duration", "aspect_ratio", "resolution", "revise", "moderation", "seed", "footnote"]],
      ["wand/kling/text-to-video", ["prompt", "settings", "options"]],
      ["wand/kling/image-to-video", ["contents", "settings", "options"]],
      ["wand/kling/omni-video", ["contents", "settings", "options"]],
      ["wand/kling/motion-control", ["contents", "settings", "options"]],
      ["wand/vidu/text-to-video", ["prompt", "style", "duration", "aspect_ratio", "resolution", "movement_amplitude", "bgm", "audio", "audio_type", "seed", "payload", "watermark", "wm_position", "wm_url"]],
      ["wand/vidu/image-to-video", ["images", "prompt", "audio", "audio_type", "voice_id", "is_rec", "bgm", "duration", "resolution", "movement_amplitude", "seed", "payload", "watermark", "wm_position", "wm_url"]],
      ["wand/vidu/start-end-to-video", ["images", "prompt", "is_rec", "duration", "resolution", "movement_amplitude", "audio", "bgm", "seed", "payload", "watermark", "wm_position", "wm_url"]],
      ["wand/vidu/reference-to-video", ["subjects", "images", "videos", "prompt", "auto_subjects", "audio", "audio_type", "duration", "aspect_ratio", "resolution", "movement_amplitude", "bgm", "seed", "payload", "watermark", "wm_position", "wm_url"]],
      ["wand/pixverse/text-to-video", ["prompt", "duration", "quality", "aspect_ratio", "camera_movement", "seed", "generate_audio_switch", "generate_multi_clip_switch"]],
      ["wand/pixverse/image-to-video", ["img_id", "img_ids", "prompt", "duration", "quality", "camera_movement", "seed", "generate_audio_switch", "generate_multi_clip_switch"]],
      ["wand/pixverse/start-end-to-video", ["prompt", "first_frame_img", "last_frame_img", "duration", "quality", "seed", "generate_audio_switch"]],
      ["wand/pixverse/reference-to-video", ["image_references", "prompt", "duration", "quality", "aspect_ratio", "generate_audio_switch", "seed"]],
      ["wand/minimax-video/generation", ["prompt", "prompt_optimizer", "fast_pretreatment", "duration", "resolution", "aigc_watermark", "first_frame_image", "last_frame_image"]],
      ["wand/minimax-video-v2/generation", ["content", "resolution", "duration", "ratio", "aigc_watermark", "extra"]],
      ["wand/vega-videos/tasks", ["content", "resolution", "ratio", "duration", "options"]],
      ["api/3d/submit", ["prompt", "image_base64", "image_url", "multi_view_images", "enable_pbr", "face_count", "generate_type", "polygon_type", "result_format", "enable_geometry"]],
      ["wand/hunyuan-image/world2-panorama", ["prompt", "image_url"]],
      ["wand/hunyuan-video/world2-scene", ["prompt", "image_url"]],
      ["wand/asrproxy/sync_transcribe", ["input_url", "data", "source", "voice_encode_format"]],
      ["wand/asrproxy/async_create", ["input_url", "source", "subtitle_format"]],
      ["wand/minimax-tts/sync_tts", ["text", "voice_setting", "audio_setting", "pronunciation_dict", "timbre_weights", "language_boost", "voice_modify", "subtitle_enable", "subtitle_type", "stream", "output_format", "aigc_watermark"]],
      ["wand/minimax-tts/sync_clone", ["audio_url", "audio_data", "tts_model", "voice_id", "text", "text_validation", "accuracy", "output_format", "file_id"]],
      ["wand/minimax-tts/sync_design", ["prompt", "preview_text", "voice_id", "output_format", "aigc_watermark"]],
      ["wand/dubbing/async_generation", ["input_url", "src_language", "dst_language"]],
      ["wand/minimax-music/generation", ["prompt", "lyrics", "lyrics_optimizer", "is_instrumental", "output_format", "audio_setting", "aigc_watermark"]],
      ["tenlai/asrproxy/create_rec_task", ["input_url", "data"]],
      ["wand/mureka-music/generation", ["lyrics", "prompt", "gender", "n"]],
      ["wand/mureka-music/easy-generation", ["prompt", "styles", "n"]],
      ["wand/mureka-music/instrumental-generation", ["prompt", "n"]],
    ];
    assert.equal(cases.length, APIS.length, "每个接口都要有字段清单");
    for (const [id, want] of cases) {
      assert.deepEqual([...fields(id)].sort(), [...want].sort(), id);
    }
  });

  it("模型白名单（官方接口的 model 取值列表）", () => {
    assert.deepEqual(ep("wand/vidu/text-to-video").models, ["vidu-video-q3-turbo", "vidu-video-q3-pro", "vidu-video-q2"]);
    assert.deepEqual(ep("wand/vidu/reference-to-video").models, ["vidu-video-q4-preview", "vidu-video-q3-turbo", "vidu-video-q3", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"]);
    // TokenPlan 表格最终版（9-23）：q3 / q2 补图生与首尾帧，q2-turbo 补多图参考
    assert.deepEqual(ep("wand/vidu/image-to-video").models, ["vidu-video-q4-preview", "vidu-video-q3-turbo", "vidu-video-q3-pro", "vidu-video-q3", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"]);
    assert.deepEqual(ep("wand/vidu/start-end-to-video").models, ["vidu-video-q3-turbo", "vidu-video-q3-pro", "vidu-video-q3", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"]);
    assert.ok(!ep("wand/vidu/text-to-video").models.includes("vidu-video-q4-preview"), "q4-preview 只支持图生 / 参考生");
    assert.ok(!apiSupportsModel(ep("wand/vidu/text-to-video"), "vidu-video-q3"));
    assert.deepEqual(ep("wand/si-image/generation").models, ["seedream-image-v5.0-pro", "seedream-image-v5.0-lite", "seedream-image-v5.0-flash"]);
    // asr 族是单族多文档：Hy / WAND 的同步 + 异步四份全部列出（编号取自文档站语音识别分类页）
    assert.deepEqual(familyOf("hy-asr-3.0-preview")!.doc, [
      "https://cloud.tencent.com/document/product/1823/135791",
      "https://cloud.tencent.com/document/product/1823/135792",
      "https://cloud.tencent.com/document/product/1823/135793",
      "https://cloud.tencent.com/document/product/1823/135794",
    ]);
  });

  it("提示词上限与官方调用指南一致（族内取最大防误伤）", () => {
    const expected: Array<[string, number]> = [
      ["hy-image-v3", 8192],
      ["seedream-image-v5.0-pro", 600],
      ["kling-image-v3", 2500],
      ["kling-video-v3", 26000],
      ["vidu-video-q3", 5000],
      ["pixverse-video-v6.0", 5000],
      ["minimax-video-h3", 2000],
      ["hy-world2-panorama", 600],
      ["minimax-speech-2.8-hd", 10000],
      ["mureka-music-v9", 2000],
      ["hy-3d-3.1", 1024],
    ];
    for (const [model, max] of expected) {
      assert.equal(familyOf(model)!.maxPromptChars, max, model);
    }
    for (const model of ["hy-asr-3.0-preview"]) {
      assert.equal(familyOf(model)!.maxPromptChars, undefined, model);
    }
  });
});

describe("请求体校验（适用模型 / 必填 / 互斥）", () => {
  const ok = (id: string, body: Record<string, unknown>) => assert.equal(checkBody(ep(id), body), undefined, JSON.stringify(body));
  const bad = (id: string, body: Record<string, unknown>, re: RegExp) => assert.match(checkBody(ep(id), body) ?? "", re);

  it("必填字段缺失报错，提示 --<flag>", () => {
    bad("wand/si-image/generation", { model: "seedream-image-v5.0-pro" }, /--prompt is required/);
    ok("wand/si-image/generation", { model: "seedream-image-v5.0-pro", prompt: "p" });
    bad("wand/minimax-tts/sync_tts", { model: "minimax-speech-2.8-hd", text: "hi" }, /--voice-setting is required/);
    bad("wand/pixverse/start-end-to-video", { model: "pixverse-video-v6.0", prompt: "p", first_frame_img: "a", duration: 5, quality: "720p" }, /--last-frame-img is required/);
    bad("wand/kling/motion-control", { model: "kling-video-motion-control-v3.0", contents: [{ type: "image", url: "a" }] }, /--settings is required/);
  });

  it("按模型必填：minimax v2.3-fast 必须给首帧", () => {
    bad("wand/minimax-video/generation", { model: "minimax-video-v2.3-fast", prompt: "p" }, /--first-frame-image is required/);
    ok("wand/minimax-video/generation", { model: "minimax-video-v2.3", prompt: "p" });
  });

  it("适用模型：模型不支持的字段本地报错", () => {
    bad("wand/si-image/generation", { model: "seedream-image-v5.0-pro", prompt: "p", tools: { type: "web_search" } }, /--tools is only supported by seedream-image-v5.0-lite/);
    ok("wand/si-image/generation", { model: "seedream-image-v5.0-lite", prompt: "p", tools: { type: "web_search" } });
    bad("wand/kling-image/generation", { model: "kling-image-v3", prompt: "p", image_list: ["a"] }, /--image-list is only supported/);
    bad("wand/kling-image/generation", { model: "kling-image-o1", prompt: "p", image: "a" }, /--image is only supported by kling-image-v3/);
    bad("wand/kling-image/generation", { model: "kling-image-o1", prompt: "p", negative_prompt: "x" }, /--negative-prompt is only supported/);
    bad("wand/kling-image/generation", { model: "kling-image-o1", prompt: "p", series_amount: 4 }, /--series-amount is only supported by kling-image-v3-omni/);
    bad("api/3d/submit", { model: "hy-3d-express", prompt: "p", face_count: 5000 }, /--face-count is only supported/);
    bad("api/3d/submit", { model: "hy-3d-3.1", prompt: "p", enable_geometry: true }, /--enable-geometry is only supported by hy-3d-express/);
    bad("wand/pixverse/text-to-video", { model: "pixverse-video-c1", prompt: "p", duration: 5, quality: "720p", generate_multi_clip_switch: true }, /only supported by pixverse-video-v6.0/);
    // v3-turbo 图生视频允许尾帧（TokenPlan 最终版 9-23：type=first_frame/last_frame，1~2 张）
    ok("wand/kling/image-to-video", { model: "kling-video-v3-turbo", contents: [{ type: "prompt", text: "p" }, { type: "first_frame", url: "u" }, { type: "last_frame", url: "v" }], settings: { resolution: "1080p", duration: 5 } });
    // h3-max 支持多模态参考（与 h3 同权，调用指南口径）
    ok("wand/minimax-video-v2/generation", { model: "minimax-video-h3-max", content: [{ type: "text", text: "p" }, { type: "image_url", image_url: { url: "u" }, role: "reference_image" }], resolution: "768P", duration: 6, ratio: "16:9" });
    ok("wand/minimax-video-v2/generation", { model: "minimax-video-h3-max", content: [{ type: "text", text: "p" }, { type: "image_url", image_url: { url: "u" }, role: "first_frame" }], resolution: "768P", duration: 6, ratio: "16:9" });
    // subjects[].videos 仅 q2-pro：其他模型本地先拦
    bad("wand/vidu/reference-to-video", { model: "vidu-video-q3", subjects: [{ name: "s", videos: ["u"] }], prompt: "p" }, /q2-pro/);
    ok("wand/vidu/reference-to-video", { model: "vidu-video-q2-pro", subjects: [{ name: "s", videos: ["u"] }], prompt: "p" });
  });

  it("模型级规则：kling-image 组图 / 负向提示词", () => {
    bad("wand/kling-image/generation", { model: "kling-image-o1", prompt: "p", result_type: "series" }, /single only/);
    ok("wand/kling-image/generation", { model: "kling-image-v3-omni", prompt: "p", result_type: "series", series_amount: "auto" });
    bad("wand/kling-image/generation", { model: "kling-image-v3-omni", prompt: "p", series_amount: 12 }, /2~9/);
    bad("wand/kling-image/generation", { model: "kling-image-v3", prompt: "p", negative_prompt: "x", image: "a" }, /text-to-image only|without --image/);
  });

  it("互斥 / 二选一", () => {
    bad("wand/hunyuan-video/generation", { model: "hy-video-v1.5" }, /requires --prompt/);
    bad("wand/hunyuan-video/generation", { model: "hy-video-v1.5", image: "a", image_url: "b" }, /only one of/);
    bad("wand/hunyuan-video/generation", { model: "hy-video-v1.5", image_url: "https://x/a.jpg", aspect_ratio: "16:9" }, /text-to-video/);
    bad("api/3d/submit", { model: "hy-3d-3.1", prompt: "p", image_url: "https://x/a.jpg" }, /mutually exclusive/);
    ok("api/3d/submit", { model: "hy-3d-3.1", prompt: "p", image_url: "https://x/a.jpg", generate_type: "Sketch" });
    bad("wand/hunyuan-video/world2-scene", { model: "hy-world2-scene", prompt: "p", image_url: "https://x/a.jpg" }, /only one of/);
    bad("wand/minimax-tts/sync_clone", { model: "minimax-voice-clone" }, /--audio-url \/ --audio-data \/ --file-id/);
    bad("wand/asrproxy/sync_transcribe", { model: "wand-asr-v1", input_url: "u", data: "d" }, /only one of/);
    bad("wand/minimax-music/generation", { model: "minimax-music-v3.0" }, /vocal songs require --lyrics/);
  });

  it("MiniMax 音乐三种模式：纯音乐须 prompt；自动写词须 prompt；人声歌曲须 lyrics", () => {
    const E = "wand/minimax-music/generation";
    const m = { model: "minimax-music-v3.0" };
    ok(E, { ...m, prompt: "钢琴", is_instrumental: true });
    bad(E, { ...m, lyrics: "x", is_instrumental: true }, /requires --prompt/);
    ok(E, { ...m, prompt: "夏日情歌", lyrics_optimizer: true });
    bad(E, { ...m, lyrics_optimizer: true }, /--prompt is required/);
    ok(E, { ...m, lyrics: "[Verse] a" });
    bad(E, { ...m, prompt: "只有描述" }, /vocal songs require --lyrics/);
  });

  it("MiniMax H3 / WAND 生视频 ratio：枚举；H3 文生必填且不可 adaptive，图生 / 参考可省", () => {
    const H = "wand/minimax-video-v2/generation";
    const base = { model: "minimax-video-h3", resolution: "768P", duration: 6 };
    const text = [{ type: "text", text: "猫" }];
    bad(H, { ...base, content: text }, /requires --ratio/);
    bad(H, { ...base, content: text, ratio: "adaptive" }, /requires --ratio/);
    ok(H, { ...base, content: text, ratio: "16:9" });
    ok(H, { ...base, content: [...text, { type: "image_url", image_url: { url: "https://x/a.jpg" }, role: "first_frame" }] });
    assert.throws(() => parseParamValue(param("wand/vega-videos/tasks", "ratio"), "5:4"), /must be one of/);
    assert.throws(() => parseParamValue(param(H, "ratio"), "5:4"), /must be one of/);
  });

  it("content 内 text 块长度：H3 拦 2000；WAND 拦 8192（调用指南口径），2000~8192 放行", () => {
    const H = "wand/minimax-video-v2/generation";
    const hb = { model: "minimax-video-h3", resolution: "768P", duration: 6, ratio: "16:9" };
    const long = "a".repeat(2001);
    bad(H, { ...hb, content: [{ type: "text", text: long }] }, /content\[\]\.text is 2001 characters/);
    ok(H, { ...hb, content: [{ type: "text", text: "a".repeat(2000) }, { type: "image_url", image_url: { url: "https://x/a.jpg" }, role: "first_frame" }] });
    const W = "wand/vega-videos/tasks";
    const wb = { model: "wand-vega-video-1.0-lite" };
    ok(W, { ...wb, content: [{ type: "text", text: "a".repeat(5000) }] });
    bad(W, { ...wb, content: [{ type: "text", text: "a".repeat(8193) }] }, /content\[\]\.text is 8193 characters/);
    // 素材块不带 text：不受长度校验影响
    ok(W, { ...wb, content: [{ type: "image_url", image_url: { url: "https://x/a.jpg" } }] });
  });

  it("音视频本地文件限制：音色复刻 mp3/m4a/wav ≤20MB；配音 mp4/mov/m4v ≤75MB", () => {
    const clone = single("wand/minimax-tts/sync_clone", "audio_data");
    assert.deepEqual([clone.formats, clone.maxBytes], [["mp3", "m4a", "wav"], 20_000_000]);
    const dub = single("wand/dubbing/async_generation", "input_url");
    assert.deepEqual([dub.formats, dub.maxBytes], [["mp4", "mov", "m4v"], 75_000_000]);
  });

  it("与官方文档对齐的模型限定：Seedream flash / Kling 生图 auto·4k / O1 时长 / HY-3D 3.1 LowPoly / Kling 动作控制 audio", () => {
    ok("wand/si-image/generation", { model: "seedream-image-v5.0-flash", prompt: "p", layer_decomposition: true, background: "transparent" });
    const K = "wand/kling-image/generation";
    ok(K, { model: "kling-image-o1", prompt: "p", image_list: [{ image: "https://x/a.png" }], aspect_ratio: "auto" });
    bad(K, { model: "kling-image-o1", prompt: "p", aspect_ratio: "auto" }, /aspect_ratio=auto/);
    bad(K, { model: "kling-image-v3", prompt: "p", aspect_ratio: "auto" }, /aspect_ratio=auto/);
    ok(K, { model: "kling-image-v3-omni", prompt: "p", resolution: "4k" });
    bad(K, { model: "kling-image-o1", prompt: "p", resolution: "4k" }, /4k/);
    const O = "wand/kling/omni-video";
    const first = { type: "first_frame", url: "https://x/a.jpg" };
    bad(O, { model: "kling-video-o1", contents: [{ type: "prompt", text: "p" }, first], settings: { duration: 8 } }, /5 or 10/);
    ok(O, { model: "kling-video-o1", contents: [{ type: "prompt", text: "p" }, first, { type: "refer_image", url: "https://x/b.jpg" }], settings: { duration: 8 } });
    bad("api/3d/submit", { model: "hy-3d-3.1", prompt: "p", generate_type: "LowPoly" }, /LowPoly/);
    ok("api/3d/submit", { model: "hy-3d-3.0", prompt: "p", generate_type: "LowPoly", polygon_type: "quadrilateral" });
    bad("api/3d/submit", { model: "hy-3d-3.1", prompt: "p", polygon_type: "triangle" }, /only supported by hy-3d-3.0/);
    bad("api/3d/submit", { model: "hy-3d-express", prompt: "p".repeat(1025) }, /1024/);
  });

  it("Vidu 参考生：subjects 与 images/videos 二选一；videos 仅 q2-pro", () => {
    bad("wand/vidu/reference-to-video", { model: "vidu-video-q2", prompt: "p" }, /exactly one/);
    bad("wand/vidu/reference-to-video", { model: "vidu-video-q2", prompt: "p", subjects: [{ name: "g" }], images: ["a"] }, /exactly one/);
    ok("wand/vidu/reference-to-video", { model: "vidu-video-q2", prompt: "p", subjects: [{ name: "g", images: ["a"] }] });
    ok("wand/vidu/reference-to-video", { model: "vidu-video-q2", prompt: "p", images: ["a"] });
    bad("wand/vidu/reference-to-video", { model: "vidu-video-q2", prompt: "p", videos: ["https://x/v.mp4"] }, /--videos is only supported by vidu-video-q2-pro/);
  });

  it("Mureka：三接口三能力——歌词成曲 lyrics 必填 / 提示词成曲 styles 仅 easy / 纯音乐；长度上限分接口（lyrics 5000、风格提示词 1024、easy prompt 2000）、n 共享 [1,3]", () => {
    const m = { model: "mureka-music-v9" };
    const G = "wand/mureka-music/generation";
    bad(G, { ...m, prompt: "lo-fi", n: 1 }, /--lyrics is required/);
    ok(G, { ...m, lyrics: "[Verse] a", prompt: "pop", gender: "female", n: 1 });
    bad(G, { ...m, lyrics: "a".repeat(5001) }, /5000/);
    bad(G, { ...m, lyrics: "a", prompt: "p".repeat(1025) }, /1024/);
    bad(G, { ...m, lyrics: "a", n: 4 }, /\[1, 3\]/);

    const E = "wand/mureka-music/easy-generation";
    ok(E, { ...m, prompt: "a bright summer love song", styles: ["pop", "rock"], n: 1 });
    bad(E, { ...m, styles: ["pop"] }, /--prompt is required/);
    // easy prompt 上限 2000 由族级 maxPromptChars 兜住
    ok(E, { ...m, prompt: "p".repeat(2000) });
    bad(E, { ...m, prompt: "p".repeat(2001) }, /2000/);
    // n 校验在族级 validateBody，三接口共享
    bad(E, { ...m, prompt: "p", n: 0 }, /\[1, 3\]/);

    const I = "wand/mureka-music/instrumental-generation";
    ok(I, { ...m, prompt: "lo-fi, warm piano", n: 1 });
    bad(I, { ...m, n: 1 }, /--prompt is required/);
    bad(I, { ...m, prompt: "p".repeat(1025) }, /1024/);
  });

  it("Kling：omni 无首帧需 settings.aspect_ratio；o1 无参考图仅 5/10 秒；motion 须有 image 与 video 块", () => {
    bad("wand/kling/omni-video", { model: "kling-video-v3-omni", contents: [{ type: "prompt", text: "p" }] }, /aspect_ratio/);
    ok("wand/kling/omni-video", { model: "kling-video-v3-omni", contents: [{ type: "prompt", text: "p" }], settings: { aspect_ratio: "16:9" } });
    // aspect_ratio 仅在有首帧时可省略（画幅跟随首帧）；base_video / feature_video 场景必传
    const v = "https://x/in.mp4";
    bad("wand/kling/omni-video", { model: "kling-video-v3-omni", contents: [{ type: "prompt", text: "p" }, { type: "base_video", url: v }] }, /aspect_ratio with base_video/);
    bad("wand/kling/omni-video", { model: "kling-video-v3-omni", contents: [{ type: "prompt", text: "p" }, { type: "feature_video", url: v }] }, /aspect_ratio with feature_video/);
    ok("wand/kling/omni-video", { model: "kling-video-v3-omni", contents: [{ type: "prompt", text: "p" }, { type: "base_video", url: v }], settings: { aspect_ratio: "16:9" } });
    ok("wand/kling/omni-video", { model: "kling-video-v3-omni", contents: [{ type: "prompt", text: "p" }, { type: "first_frame", url: "https://x/a.jpg" }] });
    bad("wand/kling/omni-video", { model: "kling-video-o1", contents: [{ type: "prompt", text: "p" }], settings: { aspect_ratio: "16:9", duration: 8 } }, /5 or 10/);
    const settings = { character_orientation: "image" };
    bad("wand/kling/motion-control", { model: "kling-video-motion-control-v3.0", contents: [{ type: "image", url: "a" }], settings }, /type="video"/);
    ok("wand/kling/motion-control", { model: "kling-video-motion-control-v3.0", contents: [{ type: "image", url: "a" }, { type: "video", url: "https://x/m.mp4" }], settings });
  });

  it("Kling 生视频（以调用指南为准）：v4 / 按模型 settings / 素材组合", () => {
    const T2V = "wand/kling/text-to-video";
    const I2V = "wand/kling/image-to-video";
    const O = "wand/kling/omni-video";
    const M = "wand/kling/motion-control";
    const p = { type: "prompt", text: "p" };
    const first = { type: "first_frame", url: "https://x/a.jpg" };
    const last = { type: "last_frame", url: "https://x/b.jpg" };
    const v = "https://x/in.mp4";

    // 文生：v4 21:9 / 30s；21:9 仅 v4；4k 仅 V3；时长按模型；audio / multi_shot 按模型
    ok(T2V, { model: "kling-video-v4", prompt: "p", settings: { aspect_ratio: "21:9", duration: 30 } });
    bad(T2V, { model: "kling-video-v3", prompt: "p", settings: { aspect_ratio: "21:9" } }, /21:9 is kling-video-v4 only/);
    bad(T2V, { model: "kling-video-v4", prompt: "p", settings: { resolution: "4k" } }, /does not support 4k/);
    ok(T2V, { model: "kling-video-v3", prompt: "p", settings: { resolution: "4k", duration: 15, multi_shot: false, audio: "native" } });
    bad(T2V, { model: "kling-video-v3", prompt: "p", settings: { duration: 16 } }, /3~15/);
    bad(T2V, { model: "kling-video-v2.6", prompt: "p", settings: { duration: 7 } }, /5 \/ 10/);
    bad(T2V, { model: "kling-video-v4", prompt: "p", settings: { audio: "native" } }, /settings\.audio is only supported by kling-video-v3 \/ kling-video-v2\.6/);
    bad(T2V, { model: "kling-video-v3-turbo", prompt: "p", settings: { multi_shot: true } }, /settings\.multi_shot/);
    bad(T2V, { model: "kling-video-v2.6", prompt: "p", settings: { audio: "native" } }, /1080p/);
    ok(T2V, { model: "kling-video-v2.6", prompt: "p", settings: { audio: "native", resolution: "1080p" } });
    // 提示词：v4 中英加权；V3 ≤3072；其余 ≤2500
    ok(T2V, { model: "kling-video-v4", prompt: "a".repeat(26000) });
    bad(T2V, { model: "kling-video-v4", prompt: "中".repeat(11001) }, /kling-video-v4 length limit/);
    bad(T2V, { model: "kling-video-v4", prompt: "a".repeat(13000) + "中".repeat(5600) }, /kling-video-v4 length limit/);
    ok(T2V, { model: "kling-video-v3", prompt: "a".repeat(3072) });
    bad(T2V, { model: "kling-video-v3-turbo", prompt: "a".repeat(2501) }, /2500/);

    // 图生：须 prompt + first_frame；素材类型按模型；音色需 audio 非 off；V2.6 / V2.5 首尾帧清晰度
    bad(I2V, { model: "kling-video-v3", contents: [first] }, /at least one type=prompt and one type=first_frame/);
    ok(I2V, { model: "kling-video-v4", contents: [p, first, last] });
    // TokenPlan 最终版（9-23）：v3-turbo 允许尾帧；但 element 仍不在其白名单
    ok(I2V, { model: "kling-video-v3-turbo", contents: [p, first, last], settings: { resolution: "1080p" } });
    bad(I2V, { model: "kling-video-v3-turbo", contents: [p, first, { type: "element", element_id: "e" }] }, /does not support block type element/);
    bad(I2V, { model: "kling-video-v4", contents: [p, first, { type: "element", element_id: "e" }] }, /does not support block type element/);
    bad(I2V, { model: "kling-video-v3", contents: [p, first, { ...first }] }, /At most 1 first_frame/);
    const voice = (id: string) => ({ type: "voice", voice_id: "vv", id });
    bad(I2V, { model: "kling-video-v2.6", contents: [p, first, voice("1")], settings: { resolution: "1080p" } }, /cannot be off or omitted/);
    ok(I2V, { model: "kling-video-v2.6", contents: [p, first, voice("1")], settings: { audio: "native", resolution: "1080p" } });
    bad(I2V, { model: "kling-video-v3", contents: [p, first, voice("1"), voice("2"), voice("3")], settings: { audio: "native" } }, /At most 2 blocks of type=voice/);
    bad(I2V, { model: "kling-video-v3", contents: [p, first, voice("1"), voice("1")], settings: { audio: "native" } }, /Duplicate block id 1/);
    bad(I2V, { model: "kling-video-v3", contents: [p, first, { type: "voice", voice_id: "vv" }], settings: { audio: "native" } }, /missing the id field/);
    bad(I2V, { model: "kling-video-v2.6", contents: [p, first, last], settings: { resolution: "1080p" } }, /720p with first\/last frames/);
    bad(I2V, { model: "kling-video-v2.5-turbo", contents: [p, first, last] }, /1080p with first\/last frames/);
    ok(I2V, { model: "kling-video-v2.5-turbo", contents: [p, first, last], settings: { resolution: "1080p" } });
    bad(I2V, { model: "kling-video-v3", contents: [{ type: "prompt", text: "a".repeat(2501) }, first] }, /2500/);

    // 全能 v4：21:9 / adaptive；不支持 base_video / audio；视频仅 URL；数量上限
    ok(O, { model: "kling-video-v4", contents: [p, { type: "feature_video", url: v }], settings: { aspect_ratio: "adaptive", duration: 30 } });
    bad(O, { model: "kling-video-v4", contents: [p, { type: "base_video", url: v }] }, /does not support base_video/);
    bad(O, { model: "kling-video-v4", contents: [p, first], settings: { audio: "off" } }, /settings\.audio is only supported by/);
    // v4 feature_video 支持本地文件（编码为 data URL）
    ok(O, { model: "kling-video-v4", contents: [p, { type: "feature_video", url: "data:video/mp4;base64,AAAA" }] });
    const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "refer_image", url: `https://x/${i}.jpg` }));
    bad(O, { model: "kling-video-v4", contents: [p, ...refs(11)] }, /At most 10 blocks of type=image/);
    // v4 图片单张 ≤30MB：本地文件编码为 data URL 后按 Base64 载荷估算（30MB 文件 → 恰 40_000_000 载荷，放行；40_000_002 → 30MB+1.5B，拦截）
    ok(O, { model: "kling-video-v4", contents: [p, { type: "refer_image", url: "data:image/jpeg;base64,AAAA" }] });
    bad(O, { model: "kling-video-v4", contents: [p, { type: "refer_image", url: "data:image/jpeg;base64," + "A".repeat(40_000_002) }] }, /30MB/);
    const els = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "element", element_id: `e${i}` }));
    bad(O, { model: "kling-video-v4", contents: [p, ...refs(10), ...els(6)] }, /at most 15 materials/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, first], settings: { aspect_ratio: "adaptive" } }, /adaptive is kling-video-v4 only/);

    // 全能 V3-Omni / O1：组合限制
    const ar = { aspect_ratio: "16:9" };
    // text 只能放 type=prompt 块（挂在素材块上上游 1201 报 prompt must have non-blank text）
    bad(O, { model: "kling-video-v3-omni", contents: [{ type: "base_video", url: v, text: "白膜" }], settings: ar }, /type=prompt/);
    bad(I2V, { model: "kling-video-v3", contents: [{ type: "first_frame", url: "https://x/a.jpg", text: "cat" }] }, /type=prompt/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, last], settings: ar }, /last_frame requires a first_frame/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, { type: "feature_video", url: v }, { type: "base_video", url: v }], settings: ar }, /At most 1 blocks/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, first, last, { type: "feature_video", url: v }] }, /last_frame is not supported with a feature_video/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, first, { type: "base_video", url: v }] }, /not supported with a base_video/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, { type: "base_video", url: v }], settings: { ...ar, audio: "native" } }, /cannot be native with a base_video/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, { type: "feature_video", url: v }], settings: { ...ar, audio: "original" } }, /must be off for kling-video-v3-omni/);
    bad(O, { model: "kling-video-v3-omni", contents: [p, { type: "feature_video", url: v }, ...refs(5)], settings: ar }, /limited to 4/);
    ok(O, { model: "kling-video-v3-omni", contents: [p, ...refs(7)], settings: ar });
    bad(O, { model: "kling-video-v3-omni", contents: [p, ...refs(8)], settings: ar }, /limited to 7/);
    bad(O, { model: "kling-video-o1", contents: [p, first], settings: { audio: "native" } }, /original \/ off only/);
    bad(O, { model: "kling-video-o1", contents: [p, first], settings: { multi_shot: true } }, /settings\.multi_shot/);
    bad(O, { model: "kling-video-o1", contents: [p, first, last, ...refs(1)] }, /together with first\/last frames/);
    bad(O, { model: "kling-video-o1", contents: [p, first], settings: { duration: 12 } }, /3~10/);
    ok(O, { model: "kling-video-v3-omni", contents: [{ type: "prompt", text: "a".repeat(3072) }, first] });
    bad(O, { model: "kling-video-o1", contents: [{ type: "prompt", text: "a".repeat(2501) }, first] }, /2500/);

    // 动作控制：视频仅 URL；element 仅 v3.0、≤1 个、须 id、朝向只能 video
    const img = { type: "image", url: "https://x/a.jpg" };
    const mv = { type: "video", url: v };
    const el = { type: "element", element_id: "e", id: "e1" };
    bad(M, { model: "kling-video-motion-control-v3.0", contents: [img, { type: "video", url: "AAAA" }], settings: { character_orientation: "video" } }, /public URLs/);
    ok(M, { model: "kling-video-motion-control-v3.0", contents: [img, mv, el], settings: { character_orientation: "video" } });
    bad(M, { model: "kling-video-motion-control-v3.0", contents: [img, mv, el], settings: { character_orientation: "image" } }, /must be video when an element/);
    bad(M, { model: "kling-video-motion-control-v3.0", contents: [img, mv, el, { ...el, id: "e2" }], settings: { character_orientation: "video" } }, /At most 1 blocks of type=element/);
    bad(M, { model: "kling-video-motion-control-v3.0", contents: [img, mv, { type: "element", element_id: "e" }], settings: { character_orientation: "video" } }, /missing the id field/);
    bad(M, { model: "kling-video-motion-control-v2.6", contents: [img, mv, el], settings: { character_orientation: "video" } }, /does not support block type element/);
  });

  it("提示词超长按族上限拦截（prompt / text）", () => {
    bad("wand/si-image/generation", { model: "seedream-image-v5.0-pro", prompt: "x".repeat(601) }, /600-character limit/);
    bad("wand/minimax-tts/sync_tts", { model: "minimax-speech-2.8-hd", text: "x".repeat(10001), voice_setting: { voice_id: "v" } }, /10000-character limit/);
  });
});

describe("参数解析（--<flag> 的值）", () => {
  it("对象：类型 / 枚举 / 范围 / 未知字段 / 必填子字段", () => {
    const voiceSetting = param("wand/minimax-tts/sync_tts", "voice_setting");
    assert.deepEqual(parseParamValue(voiceSetting, '{"voice_id":"v1","speed":1.5}'), { voice_id: "v1", speed: 1.5 });
    assert.throws(() => parseParamValue(voiceSetting, '{"voice_id":"v","speed":"fast"}'), /speed must be a number/);
    assert.throws(() => parseParamValue(voiceSetting, '{"voice_id":"v","speed":3}'), /speed must be <= 2/);
    assert.throws(() => parseParamValue(voiceSetting, '{"voice_id":"v","emotion":"loud"}'), /emotion must be one of/);
    assert.throws(() => parseParamValue(voiceSetting, '{"voice_id":"v","unknown":1}'), /unknown field 'unknown'/);
    assert.throws(() => parseParamValue(voiceSetting, '{"speed":1}'), /requires field 'voice_id'/);
    assert.throws(() => parseParamValue(voiceSetting, "[1]"), /must be a JSON object/);
    // Kling 图生的 settings 无 aspect_ratio：传了即未知字段
    assert.throws(() => parseParamValue(param("wand/kling/image-to-video", "settings"), '{"aspect_ratio":"16:9"}'), /unknown field 'aspect_ratio'/);
  });

  it("数组：对象数组逐元素校验；字符串数组可直接给单个值", () => {
    const weights = param("wand/minimax-tts/sync_tts", "timbre_weights");
    assert.deepEqual(parseParamValue(weights, '[{"voice_id":"v1","weight":50}]'), [{ voice_id: "v1", weight: 50 }]);
    assert.throws(() => parseParamValue(weights, '[{"weight":50}]'), /requires field 'voice_id'/);
    assert.throws(() => parseParamValue(weights, '[{"voice_id":"v1","weight":0}]'), /weight must be >= 1/);
    const images = param("wand/si-image/generation", "images");
    assert.deepEqual(parseParamValue(images, '["a.png","https://x/b.jpg"]'), ["a.png", "https://x/b.jpg"]);
    assert.deepEqual(parseParamValue(images, "https://x/b.jpg"), ["https://x/b.jpg"]);
    assert.throws(() => parseParamValue(param("wand/kling/image-to-video", "contents"), "x"), /must be valid JSON/);
  });

  it("单值：choices 拦截 / 布尔必须 true|false / 数字枚举 / 字符串不被转类型", () => {
    const subtitleType = param("wand/minimax-tts/sync_tts", "subtitle_type");
    assert.equal(parseParamValue(subtitleType, "sentence"), "sentence");
    assert.throws(() => parseParamValue(subtitleType, "para"), /must be one of: sentence, word/);
    assert.equal(parseParamValue(param("wand/minimax-tts/sync_tts", "aigc_watermark"), "true"), true);
    assert.throws(() => parseParamValue(param("wand/minimax-tts/sync_tts", "aigc_watermark"), "yes"), /expects true or false/);
    const genPixels = param("wand/hunyuan-image/v35-generation", "generate_max_pixels");
    assert.equal(parseParamValue(genPixels, "4194304"), 4194304);
    // 非档位值不再本地硬拒：文档说明由服务端按最近面积归档
    assert.equal(parseParamValue(genPixels, "999"), 999);
    assert.equal(parseParamValue(param("wand/si-image/generation", "size"), "1024"), "1024");
    // series_amount：数字或 auto
    assert.equal(parseParamValue(param("wand/kling-image/generation", "series_amount"), "4"), 4);
    assert.equal(parseParamValue(param("wand/kling-image/generation", "series_amount"), "auto"), "auto");
  });

  it("help 用法：数组 '[...]'、对象 '{...}'、枚举 <a|b>", () => {
    assert.equal(paramUsage(param("wand/si-image/generation", "images")), `--images '["…","…"]'`);
    assert.equal(paramUsage(param("wand/si-image/generation", "optimize_prompt_options")), `--optimize-prompt-options '{"mode":…}'`);
    assert.equal(paramUsage(param("wand/minimax-video-v2/generation", "content")), `--content '[{"type":…,"text":…,"image_url":{"url":…},"video_url":{"url":…},"audio_url":{"url":…},"role":…}]'`);
    assert.equal(paramUsage(param("wand/si-image/generation", "background")), "--background <transparent|opaque>");
    assert.match(paramHelpText(param("wand/si-image/generation", "background")), /仅 seedream-image-v5.0-pro|seedream-image-v5.0-pro .*only/);
  });
});

describe("本地文件编码位置（mapMedia）", () => {
  const up = (s: string) => s.toUpperCase();
  it("值本身 / 字符串数组 / 对象（数组）子路径，数组逐项展开", () => {
    assert.equal(mapMedia("a", undefined, up), "A");
    assert.deepEqual(mapMedia(["a", "b"], undefined, up), ["A", "B"]);
    assert.deepEqual(mapMedia([{ type: "prompt", text: "t" }, { type: "first_frame", url: "u" }], ["url"], up), [
      { type: "prompt", text: "t" },
      { type: "first_frame", url: "U" },
    ]);
    assert.deepEqual(mapMedia([{ type: "image_url", image_url: { url: "u" } }], ["image_url.url"], up), [{ type: "image_url", image_url: { url: "U" } }]);
    assert.deepEqual(mapMedia([{ role: "user", content: [{ type: "image_url", image_url: { url: "u" } }, { type: "text", text: "t" }] }], ["content.image_url.url"], up), [
      { role: "user", content: [{ type: "image_url", image_url: { url: "U" } }, { type: "text", text: "t" }] },
    ]);
    assert.deepEqual(mapMedia([{ name: "g", images: ["a", "b"] }], ["images"], up), [{ name: "g", images: ["A", "B"] }]);
  });

  it("可收本地文件的字段都声明了编码规则；只收 URL 的字段标 urlOnly", () => {
    assert.equal(single("wand/si-image/generation", "images").encoding, "dataUrl");
    assert.equal(single("wand/kling-image/generation", "image").encoding, "raw");
    assert.equal(single("wand/hunyuan-video/generation", "image").encoding, "dataUrl");
    assert.equal(single("wand/kling/image-to-video", "contents").encoding, "dataUrl");
    assert.deepEqual(single("wand/kling/image-to-video", "contents").keys, ["url"]);
    // omni 的 contents[].url 同时承载图片与视频：type=auto（按扩展名分派），视频 mp4/mov ≤75MB
    const omniUrl = single("wand/kling/omni-video", "contents");
    assert.equal(omniUrl.type, "auto");
    assert.equal(omniUrl.encoding, "dataUrl");
    assert.deepEqual(omniUrl.formats, ["mp4", "mov"]);
    assert.equal(omniUrl.maxBytes, 75_000_000);
    // vega：content 三规则——image_url / audio_url 可本地（dataUrl；audio 时长须 2~15s）；
    // video_url 仅公网 URL（拒绝内联 base64）
    const vegaContent = param("wand/vega-videos/tasks", "content").media as MediaSpec[];
    assert.ok(Array.isArray(vegaContent), "content.media 应为数组（三规则）");
    assert.deepEqual(
      vegaContent.map((m) => [m.encoding, m.keys, m.type]),
      [["dataUrl", ["image_url.url"], "image"], ["urlOnly", ["video_url.url"], "image"], ["dataUrl", ["audio_url.url"], "media"]],
    );
    assert.equal(vegaContent[2]!.maxBytes, 15_000_000);
    assert.equal(single("wand/asrproxy/async_create", "input_url").encoding, "urlOnly");
    assert.equal(single("wand/asrproxy/sync_transcribe", "data").encoding, "raw");
    // ASR 同步 data ≤75MB（TokenPlan 最终版 9-23；原实现无上限）
    assert.equal(single("wand/asrproxy/sync_transcribe", "data").maxBytes, 75_000_000);
    // panorama 参考图改名 image_url 单值仅 URL（TokenPlan 最终版 9-23；与 world2-scene 姊妹接口对齐）
    assert.equal(single("wand/hunyuan-image/world2-panorama", "image_url").encoding, "urlOnly");
    assert.ok(!ep("wand/hunyuan-image/world2-panorama").params.some((p) => p.path === "images"), "panorama 不再有 images 数组参数");
    // WAND_IMAGE input：0~10 张（TokenPlan 最终版 9-23）
    assert.match(param("wand/vega-images/generations", "input").desc.zh, /0~10 张/);
    assert.equal(single("wand/dubbing/async_generation", "input_url").encoding, "dataUrl");
    assert.equal(single("api/3d/submit", "image_base64").encoding, "raw");
    // PixVerse：img_id 单图可本地（dataUrl）；img_ids 多图模板仅 URL（TokenPlan 表格明确）
    assert.equal(single("wand/pixverse/image-to-video", "img_id").encoding, "dataUrl");
    assert.equal(single("wand/pixverse/image-to-video", "img_ids").encoding, "urlOnly");
    // minimax v2 三规则：image_url 图片可本地（dataUrl），video_url ≤50MB / audio_url ≤15MB 也可本地
    const content = param("wand/minimax-video-v2/generation", "content").media as MediaSpec[];
    assert.ok(Array.isArray(content), "content.media 应为数组（三规则）");
    assert.deepEqual(
      content.map((m) => [m.encoding, m.keys?.[0], m.maxBytes]),
      [["dataUrl", "image_url.url", undefined], ["dataUrl", "video_url.url", 50_000_000], ["dataUrl", "audio_url.url", 15_000_000]],
    );
    // v2.3-fast 不支持尾帧
    assert.deepEqual(param("wand/minimax-video/generation", "last_frame_image").models, ["minimax-video-v2.3"]);
    // subjects 双规则：images 可本地（dataUrl），videos 也可本地（dataUrl，mp4/avi/mov ≤20MB）
    const subjects = param("wand/vidu/reference-to-video", "subjects").media as MediaSpec[];
    assert.ok(Array.isArray(subjects), "subjects.media 应为数组（双规则）");
    assert.deepEqual(
      subjects.map((m) => [m.encoding, m.keys?.[0]]),
      [["dataUrl", "images"], ["dataUrl", "videos"]],
    );
  });
});

describe("--param / --body（覆盖层）", () => {
  it("key=value 一律字符串，key:=json 按 JSON 解析；键支持点路径", () => {
    assert.deepEqual(parseParams(["n:=2", "id=123", "style=anime", "settings.audio=native", "flag:=true", "s=true"]), {
      n: 2,
      id: "123",
      style: "anime",
      settings: { audio: "native" },
      flag: true,
      s: "true",
    });
    assert.deepEqual(parseParams(['cfg:={"a":1}', "l:=[1,2]", "z:=null", "e=", 'q="x"', "url=https://x/a?b=c"]), {
      cfg: { a: 1 },
      l: [1, 2],
      z: null,
      e: "",
      q: '"x"',
      url: "https://x/a?b=c",
    });
  });

  it("缺等号 / 空键 / := 后不是合法 JSON 报错", () => {
    assert.throws(() => parseParams(["oops"]));
    assert.throws(() => parseParams([":=1"]));
    assert.throws(() => parseParams(["cfg:={bad"]), /valid JSON/);
  });

  it("拒收原型链键名，嵌套 JSON 里的也剔除", () => {
    assert.throws(() => parseParams(["__proto__.polluted=1"]), /Invalid key path/);
    assert.throws(() => parseParams(["a.constructor.prototype=1"]), /Invalid key path/);
    assert.throws(() => parseParams(["a..b=1"]), /Invalid key path/);
    const v = parseParams(['x:={"__proto__":{"polluted":1},"ok":1}']);
    assert.deepEqual(v, { x: { ok: 1 } });
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("deepMerge 深合并对象、整体替换数组、override 为 undefined 时保留 base", () => {
    assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
    assert.deepEqual(deepMerge({ a: { x: 1, y: 2 }, l: [1] }, { a: { y: 3 }, l: [2] }), { a: { x: 1, y: 3 }, l: [2] });
  });

  it("校验文案跟随界面语言（参数解析 / 必填 / 族级规则 / --param）", () => {
    const voiceSetting = param("wand/minimax-tts/sync_tts", "voice_setting");
    const cases: Array<[() => unknown, RegExp, RegExp]> = [
      [() => parseParamValue(voiceSetting, '{"voice_id":"v","speed":3}'), /speed 须 <= 2/, /speed must be <= 2/],
      [() => parseParamValue(voiceSetting, '{"speed":1}'), /缺少必填字段「voice_id」/, /requires field 'voice_id'/],
      [() => parseParams(["__proto__.x=1"]), /非法的键路径/, /Invalid key path/],
      [() => parseParams(["oops"]), /--param 的格式为/, /--param expects/],
    ];
    const bodyCases: Array<[string, Record<string, unknown>, RegExp, RegExp]> = [
      ["wand/mureka-music/generation", { model: "mureka-music-v9", prompt: "p" }, /--lyrics 必填/, /--lyrics is required/],
      ["wand/vidu/reference-to-video", { model: "vidu-video-q2", prompt: "p" }, /恰好选一种/, /exactly one/],
      ["wand/hunyuan-video/world2-scene", { model: "hy-world2-scene" }, /需要传 --prompt \/ --image-url 之一/, /requires one of --prompt \/ --image-url/],
    ];
    try {
      for (const [lang, idx] of [["zh", 1], ["en", 2]] as const) {
        initLang(lang);
        for (const c of cases) assert.throws(c[0], c[idx], `${lang} ${c[idx]}`);
        for (const [api, body, zh, en] of bodyCases) assert.match(checkBody(ep(api), body) ?? "", lang === "zh" ? zh : en, `${lang} ${api}`);
      }
      initLang("zh");
      assert.doesNotMatch(checkBody(ep("wand/mureka-music/generation"), { model: "mureka-music-v9", prompt: "p" }) ?? "", /is required/);
    } finally {
      initLang("en");
    }
  });

  it("parseResponse：未到终态却带平台错误信封 → 失败（不再无限轮询）", () => {
    const kling = ep("wand/kling-image/generation").family;
    const envelope = { error: { message: "ok", type: "image_generation_user_error", param: null, code: "server_error" } };
    assert.equal(kling.parse(envelope).state, "running");
    const r = parseResponse(kling, envelope);
    assert.equal(r.state, "failed");
    assert.match(r.error ?? "", /server_error/);
    assert.match(r.error ?? "", /image_generation_user_error/);
    // 正常的进行中 / 成功响应不受影响；code 为 0 不算错误
    assert.equal(parseResponse(kling, { data: { task_status: "processing" } }).state, "running");
    assert.equal(parseResponse(kling, { data: { task_status: "processing" }, error: { code: 0 } }).state, "running");
    assert.equal(parseResponse(kling, { data: { task_status: "processing" }, error: {} }).state, "running");
    const ok = { data: { task_status: "succeed", task_result: { images: [{ url: "https://x/1.png" }] } } };
    assert.deepEqual(parseResponse(kling, ok), kling.parse(ok));
  });

  it("deepMerge 跳过原型链键名", () => {
    const merged = deepMerge({ a: 1 } as Record<string, unknown>, JSON.parse('{"__proto__":{"polluted":1},"b":2}'));
    assert.deepEqual(merged, { a: 1, b: 2 });
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});
