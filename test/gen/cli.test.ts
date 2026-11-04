/**
 * +gen 命令层：
 *   - 接口字段 flag（--dry-run 跑真实 CLI 进程）：flag 是按 argv 里的接口 ID 动态挂载的，注册表单测覆盖不到
 *     「flag 挂载 → commander 解析 → 本地文件编码 → 合并 → 校验」这条链路
 *   - help 写法改写：末位 help → --help；+gen help <子命令|接口> → +gen <子命令|接口> --help
 * 本地任务记录见 tasks.test.ts。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { normalizeHelpArg } from "../../src/util/help-alias.js";
import { backoffMs, dedupePath, download, fetchWithRetry, parseSseBody, saveTexts, withRateLimitRetry } from "../../src/commands/gen.js";
import { initLang } from "../../src/core/i18n.js";
import { expandHome } from "../../src/util/expand-home.js";

const CLI = path.join(process.cwd(), "dist", "main.cjs");

function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", [CLI, "--json", "+gen", ...args, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, THCLI_LANG: "en" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      // 本地视频 dataUrl 编码后请求体可达数 MB（如 2.3MB mp4 → ~3MB base64），默认 1MB 会截断误报
      maxBuffer: 32 * 1024 * 1024,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

function body(args: string[]): Record<string, unknown> {
  const { out, code } = run(args);
  assert.equal(code, 0, out);
  return (JSON.parse(out) as { Body: Record<string, unknown> }).Body;
}

/** 子命令级执行（不带 --dry-run，apis/tasks 等子命令未挂该选项） */
function runSub(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, THCLI_LANG: "en" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

describe("+gen 接口字段 flag（--dry-run）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-gen-"));
  const png = path.join(dir, "a.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // 真实 mp4 资产（vidu subjects[].videos 的 dataUrl 媒体编码用）
  const mp4 = path.join(process.cwd(), "test", "assets", "videos", "dance-8s.mp4");
  const mp3 = path.join(process.cwd(), "test", "assets", "audio", "commons-en-speech.mp3");

  it("flag 名即字段名：--prompt --size --sequential-image-generation 直接进请求体", () => {
    const b = body(["wand/si-image/generation", "--model", "seedream-image-v5.0-lite", "--prompt", "cat", "--size", "2K", "--sequential-image-generation", "auto", "--watermark", "true"]);
    assert.deepEqual(b, { model: "seedream-image-v5.0-lite", prompt: "cat", size: "2K", sequential_image_generation: "auto", watermark: true });
  });

  it("数组 / 对象传 JSON；本地图片按字段规则编码（dataUrl / 裸 Base64）", () => {
    const b = body(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "cat", "--images", `["https://x/a.jpg","${png}"]`, "--optimize-prompt-options", '{"mode":"fast"}']);
    const images = b["images"] as string[];
    assert.equal(images[0], "https://x/a.jpg");
    assert.match(images[1]!, /^data:image\/png;base64,/);
    assert.deepEqual(b["optimize_prompt_options"], { mode: "fast" });

    const k = body(["wand/kling/image-to-video", "--model", "kling-video-v3", "--contents", `[{"type":"prompt","text":"cat"},{"type":"first_frame","url":"${png}"}]`]);
    const url = (k["contents"] as Array<{ url: string }>)[1]!.url;
    assert.match(url, /^data:image\/png;base64,/, "Kling 收 data URL");

    // vega：image_url / audio_url 本地文件编码为 data URL（audio 时长须 2~15s）；
    // video_url 仅公网 URL（拒绝内联 base64）
    const v = body(["wand/vega-videos/tasks", "--content", `[{"type":"text","text":"cat"},{"type":"image_url","image_url":{"url":"${png}"},"role":"first_frame"}]`]);
    assert.match((v["content"] as Array<{ image_url: { url: string } }>)[1]!.image_url.url, /^data:image\/png;base64,/);
    const v2 = body(["wand/vega-videos/tasks", "--content", `[{"type":"text","text":"cat"},{"type":"audio_url","audio_url":{"url":"${mp3}"},"role":"reference_audio"}]`]);
    assert.match((v2["content"] as Array<{ audio_url: { url: string } }>)[1]!.audio_url.url, /^data:audio\/mpeg;base64,/);

    // ASR 同步 data：本地文件 → 裸 Base64（无 data: 前缀）
    const a = body(["wand/asrproxy/sync_transcribe", "--model", "hy-asr-3.0-preview", "--data", mp3]);
    assert.ok(!String(a["data"]).startsWith("data:") && String(a["data"]).length > 100, "ASR data 裸 Base64");

    // Seedream：tiff / heic / heif 本地文件编码（IMAGE_MIME 补齐前会被误拒为不支持格式）
    for (const [ext, mime] of [["tiff", "image/tiff"], ["heic", "image/heic"], ["heif", "image/heif"]] as const) {
      const f = path.join(os.tmpdir(), `thcli-mime.${ext}`);
      fs.writeFileSync(f, Buffer.from([0, 1, 2, 3]));
      const s = body(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "p", "--images", f]);
      assert.ok((s["images"] as string[])[0]!.startsWith(`data:${mime};base64,`), `${ext} → ${mime}`);
      fs.rmSync(f);
    }
  });

  it("单接口模型可省略 --model；--param 补充未收录字段（= 字符串、:= JSON）", () => {
    const b = body(["wand/hunyuan-image/v3-generation", "--prompt", "cat", "--param", "new_field:=1", "--param", "tag=1"]);
    assert.deepEqual(b, { model: "hy-image-v3", prompt: "cat", new_field: 1, tag: "1" });
  });

  it("覆盖关系：接口参数 < --param < --body；对象逐层合并", () => {
    const b = body([
      "wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "flag", "--size", "2K",
      "--optimize-prompt-options", '{"mode":"standard"}',
      "--param", "prompt=param", "--param", "size=1K", "--param", "optimize_prompt_options.mode=fast",
      "--body", '{"prompt":"body"}',
    ]);
    assert.deepEqual(b, { model: "seedream-image-v5.0-pro", prompt: "body", size: "1K", optimize_prompt_options: { mode: "fast" } });
  });

  it("注册表默认值：flag 未传时写入请求体，4 个 minimax 音频接口 output_format 均默认 url；显式 flag / --param / --body 可覆盖", () => {
    // 缺陷回归：默认不传时上游走 hex/base64，长文本响应体超限被拒 502 502001。
    // 机制只测一个接口不够——4 个 default 是独立手写数据，任何一个漏写都要能发现
    const cases: Array<[string, string[]]> = [
      ["wand/minimax-tts/sync_tts", ["--model", "minimax-speech-2.8-hd", "--text", "hi", "--voice-setting", '{"voice_id":"male-qn-qingse"}']],
      ["wand/minimax-tts/sync_clone", ["--model", "minimax-voice-clone", "--audio-url", "https://x/a.mp3"]],
      ["wand/minimax-tts/sync_design", ["--model", "minimax-voice-design", "--prompt", "deep male", "--preview-text", "hi"]],
      ["wand/minimax-music/generation", ["--model", "minimax-music-v3.0", "--lyrics", "[Verse] x"]],
    ];
    for (const [api, base] of cases) assert.equal(body([api, ...base])["output_format"], "url", api);
    const tts = cases[0]!;
    assert.equal(body([tts[0], ...tts[1], "--output-format", "hex"])["output_format"], "hex");
    assert.equal(body([tts[0], ...tts[1], "--param", "output_format=hex"])["output_format"], "hex");
    assert.equal(body([tts[0], ...tts[1], "--body", '{"output_format":"hex"}'])["output_format"], "hex");
  });

  it("Mureka 三接口：generation 仅歌词成曲四字段（无 styles），easy/instrumental 的 flag 挂载与请求体", () => {
    assert.deepEqual(body(["wand/mureka-music/generation", "--model", "mureka-music-v9", "--lyrics", "[Verse] x"]), { model: "mureka-music-v9", lyrics: "[Verse] x" });
    assert.deepEqual(
      body(["wand/mureka-music/easy-generation", "--model", "mureka-music-v9", "--prompt", "summer", "--styles", '["pop"]']),
      { model: "mureka-music-v9", prompt: "summer", styles: ["pop"] },
    );
    assert.deepEqual(body(["wand/mureka-music/instrumental-generation", "--model", "mureka-music-v9", "--prompt", "lo-fi"]), { model: "mureka-music-v9", prompt: "lo-fi" });
    // --styles 已从 generation 挪到 easy：commander 报未知选项
    assert.match(run(["wand/mureka-music/generation", "--model", "mureka-music-v9", "--lyrics", "x", "--styles", '["pop"]']).out, /unknown option/);
  });

  it("Tenlai 异步 ASR：input_url 直传 URL；--data 本地音频转裸 Base64（png 会被媒体格式校验拦）；缺二选一 / 两个都传本地拦", () => {
    assert.deepEqual(body(["tenlai/asrproxy/create_rec_task", "--input-url", "https://x/a.mp3"]), { model: "tenlai-asr-v1.0", input_url: "https://x/a.mp3" });
    const wavFile = path.join(dir, "a.wav");
    fs.writeFileSync(wavFile, Buffer.from([0x52, 0x49, 0x46, 0x46])); // "RIFF"
    const withData = body(["tenlai/asrproxy/create_rec_task", "--data", wavFile]);
    assert.equal(withData["model"], "tenlai-asr-v1.0");
    assert.equal(withData["data"], Buffer.from([0x52, 0x49, 0x46, 0x46]).toString("base64"), "本地音频读字节转裸 Base64");
    assert.match(run(["tenlai/asrproxy/create_rec_task", "--data", png]).out, /not a supported audio\/video format/, "音频字段拒非音频文件");
    assert.match(run(["tenlai/asrproxy/create_rec_task"]).out, /requires one of/);
    assert.match(run(["tenlai/asrproxy/create_rec_task", "--input-url", "https://x/a.mp3", "--data", wavFile]).out, /accepts only one of/);
  });

  it("MiniMax 文档更新：sync_tts --stream 进请求体且流式不注入 url 默认（SSE 仅支持 hex）；sync_clone --file-id 与三选一校验", () => {
    const base = ["wand/minimax-tts/sync_tts", "--model", "minimax-speech-2.8-hd", "--text", "hi", "--voice-setting", '{"voice_id":"male-qn-qingse"}'];
    // stream=true：不注入 output_format（上游流式仅支持 hex 分段，url 会被拒 400）
    assert.deepEqual(body([...base, "--stream", "true"]), { model: "minimax-speech-2.8-hd", text: "hi", voice_setting: { voice_id: "male-qn-qingse" }, stream: true });
    assert.equal(body([...base, "--stream", "true", "--output-format", "hex"])["output_format"], "hex");
    // stream=true + 显式 url：本地早拦截（上游 400 的原文透出已验证，但报在本地更快）
    assert.match(run([...base, "--stream", "true", "--output-format", "url"]).out, /only supports hex/);
    assert.deepEqual(body(["wand/minimax-tts/sync_clone", "--model", "minimax-voice-clone", "--file-id", "123"]), {
      model: "minimax-voice-clone",
      output_format: "url",
      file_id: 123,
    });
    // 文档更新：audio_url / audio_data / file_id 至少传一个（原来是前两者二选一）
    assert.match(run(["wand/minimax-tts/sync_clone", "--model", "minimax-voice-clone"]).out, /requires one of/);
  });

  it("parseSseBody：data: JSON 分段 hex 顺序拼接 + [DONE] + 末段 usage 保留；请求体 format 回填；非 SSE 不误判", () => {
    const sse = [
      'data: {"base_resp":{"status_code":0},"data":{"audio":"6162","status":1}}',
      "",
      'data: {"base_resp":{"status_code":0},"data":{"audio":"63","status":1}}',
      "",
      'data: {"base_resp":{"status_code":0},"data":{"status":2},"status":"completed","usage":{"total_tokens":1750}}',
      "",
      "data: [DONE]",
    ].join("\n");
    const r = parseSseBody(sse, { audio_setting: { format: "wav" } })!;
    const data = r["data"] as Record<string, unknown>;
    assert.equal(data.audio, "616263", "hex 分段顺序拼接");
    assert.equal(data.status, 2);
    assert.equal(r["status"], "completed");
    assert.deepEqual(r["usage"], { total_tokens: 1750 });
    assert.equal((r["extra_info"] as Record<string, unknown>).audio_format, "wav", "流式末段无 extra_info，从请求体回填");
    assert.equal(parseSseBody('{"data":{"audio":"x"}}'), undefined, "非 SSE 文本不误判");
    assert.equal(parseSseBody("data: not-json"), undefined, "单段解析失败整体放弃");
    assert.equal(parseSseBody(""), undefined, "空文本不误判");
  });

  it("model 可由 --param / --body 指定，以最终请求体为准做接口白名单校验", () => {
    assert.equal(body(["wand/si-image/generation", "--prompt", "x", "--param", "model=seedream-image-v5.0-lite"])["model"], "seedream-image-v5.0-lite");
    assert.equal(
      body(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", "--body", '{"model":"seedream-image-v5.0-flash"}'])["model"],
      "seedream-image-v5.0-flash",
    );
    const { out, code } = run(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", "--body", '{"model":"kling-video-v3"}']);
    assert.notEqual(code, 0);
    assert.match(out, /kling-video-v3/);
  });

  it("其它接口的字段 / 已删除的公共参数：commander 直接报未知选项", () => {
    for (const flag of ["--aspect-ratio", "--ratio", "--duration", "--input"]) {
      const { out, code } = run(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", flag, "1"]);
      assert.notEqual(code, 0, flag);
      assert.match(out, /unknown option/, flag);
    }
  });

  it("本地校验：只收 URL 的字段拒本地文件；模型不支持的字段报错；必填缺失报错", () => {
    // vega video_url 仅公网 URL（拒绝内联 base64）：本地 mp4 直接拦截
    assert.match(run(["wand/vega-videos/tasks", "--content", `[{"type":"video_url","video_url":{"url":"${mp4}"}}]`]).out, /only accepts public URLs/);
    assert.match(run(["wand/si-image/generation", "--model", "seedream-image-v5.0-pro", "--prompt", "x", "--tools", '{"type":"web_search"}']).out, /only supported by seedream-image-v5.0-lite/);
    assert.match(run(["wand/minimax-tts/sync_tts", "--model", "minimax-speech-2.8-hd", "--text", "hi"]).out, /--voice-setting is required/);
  });

  it("本地校验：只收 URL 的字段传不存在的本地路径也拦截（不当 URL 发到服务端）", () => {
    // 缺陷回归：相对路径在 cwd 下不存在时曾被当普通 URL 字符串放行，
    // 直到服务端 url 校验 400002 才暴露，且已消耗一次提交
    assert.match(
      run(["wand/asrproxy/async_create", "--model", "hy-asr-3.0-preview", "--input-url", "assets/audio/speech-zh-10s.wav"]).out,
      /only accepts a public URL/,
    );
    // 不存在的绝对路径同样拦截
    assert.match(
      run(["wand/hunyuan-video/world2-scene", "--prompt", "x", "--image-url", "/nonexistent/a.png"]).out,
      /only accepts a public URL/,
    );
    // panorama 参考图改名 image_url（TokenPlan 最终版 9-23）：本地拦截、URL 直传
    assert.match(
      run(["wand/hunyuan-image/world2-panorama", "--prompt", "x", "--image-url", "/nonexistent/a.png"]).out,
      /only accepts a public URL/,
    );
    const pano = body(["wand/hunyuan-image/world2-panorama", "--prompt", "x", "--image-url", "https://example.com/a.jpg"]);
    assert.equal(pano["image_url"], "https://example.com/a.jpg");
  });

  it("本地校验：混元生图 --size 格式/宽高/面积（v3 与 v3.5 约束不同；--param 旁路也拦）", () => {
    const e = (args: string[]) => run(args).out;
    const v3 = ["wand/hunyuan-image/v3-generation", "--model", "hy-image-v3", "--prompt", "cat"];
    // 缺陷复现值：2048x2048 面积 4M > 1024x1024
    assert.match(e([...v3, "--size", "2048x2048"]), /area exceeds the 1024x1024 limit/);
    // 宽高低于下限 [512,2048]
    assert.match(e([...v3, "--size", "1024x300"]), /sides must be within \[512,2048\]/);
    // 格式错
    assert.match(e([...v3, "--size", "big"]), /must be WxH/);
    // 合法值放行；--param 覆盖旁路同样拦截
    assert.equal(body([...v3, "--size", "1024x1024"])["size"], "1024x1024");
    assert.match(e([...v3, "--param", "size=2048x2048"]), /area exceeds the 1024x1024 limit/);
    // v3.5：边界 4096x4096 = 16777216 恰好放行，4097x4096 超面积
    const v35 = ["wand/hunyuan-image/v35-generation", "--model", "hy-image-v3.5-preview", "--messages", '[{"role":"user","content":[{"type":"text","text":"cat"}]}]'];
    assert.equal(body([...v35, "--size", "4096x4096"])["size"], "4096x4096");
    assert.match(e([...v35, "--size", "4097x4096"]), /area exceeds the 16777216 limit/);
    // v3.5：只超宽高上限、面积未超（8193x2047=16775171）→ 报宽高而非面积
    assert.match(e([...v35, "--size", "8193x2047"]), /sides must be within \[256,8192\]/);
    // v3：宽高与面积全部顶格（2048x512=1048576）→ 放行
    assert.equal(body([...v3, "--size", "2048x512"])["size"], "2048x512");
    // 大写 X 分隔不是合法格式（与服务端 WxH 小写一致）
    assert.match(e([...v3, "--size", "1024X1024"]), /must be WxH/);
    // --body 最高优先级旁路同样拦截
    assert.match(
      e([...v3, "--body", '{"model":"hy-image-v3","prompt":"cat","size":"2048x2048"}']),
      /area exceeds the 1024x1024 limit/,
    );
  });

  it("本地校验：嵌套媒体子路径（vidu subjects[].videos，dataUrl 编码，mp4/avi/mov ≤20MB）", () => {
    // 存在的本地文件但不在音视频格式白名单 → 拦截
    assert.match(
      run(["wand/vidu/reference-to-video", "--model", "vidu-video-q2-pro", "--prompt", "@a dancing", "--subjects", `[{"name":"a","videos":["${png}"]}]`]).out,
      /not a supported audio\/video format/,
    );
    // 本地 mp4 → data URL 编码（URL 生成不走网络，dry-run 只编码请求体）
    const local = body(["wand/vidu/reference-to-video", "--model", "vidu-video-q2-pro", "--prompt", "@a dancing", "--subjects", `[{"name":"a","videos":["${mp4}"]}]`]);
    assert.match((local["subjects"] as Array<{ videos: string[] }>)[0]!.videos[0]!, /^data:video\/mp4;base64,/);
    // subjects[].images 仍可传本地文件（dataUrl 编码），且 videos 传 URL 正常放行
    const b = body(["wand/vidu/reference-to-video", "--model", "vidu-video-q2-pro", "--prompt", "@a dancing", "--subjects", `[{"name":"a","images":["${png}"],"videos":["https://x/dance.mp4"]}]`]);
    const s = (b["subjects"] as Array<{ images: string[]; videos: string[] }>)[0]!;
    assert.match(s.images[0]!, /^data:image\/png;base64,/);
    assert.equal(s.videos[0], "https://x/dance.mp4");
  });
});

const N = (...args: string[]): string[] => normalizeHelpArg(["node", "thcli", ...args]).slice(2);

describe("normalizeHelpArg", () => {
  it("末位 help 改写成 --help；前一项是选项名时不改", () => {
    assert.deepEqual(N("+gen", "status", "help"), ["+gen", "status", "--help"]);
    assert.deepEqual(N("+gen", "help"), ["+gen", "--help"]);
    assert.deepEqual(N("agent", "install", "--name", "help"), ["agent", "install", "--name", "help"]);
  });

  it("+gen help <子命令|接口ID> 改写成 +gen <子命令|接口ID> --help", () => {
    assert.deepEqual(N("+gen", "help", "status"), ["+gen", "status", "--help"]);
    assert.deepEqual(N("+gen", "help", "tasks"), ["+gen", "tasks", "--help"]);
    assert.deepEqual(N("+gen", "help", "resource", "kling-voice"), ["+gen", "resource", "kling-voice", "--help"]);
    assert.deepEqual(N("--lang", "en", "+gen", "help", "wand/vidu/text-to-video"), ["--lang", "en", "+gen", "wand/vidu/text-to-video", "--help"]);
  });

  it("+gen 接口调用里的 help 值不改（如 --prompt help）", () => {
    assert.deepEqual(N("+gen", "wand/si-image/generation", "--prompt", "help"), ["+gen", "wand/si-image/generation", "--prompt", "help"]);
  });
});

describe("429 退避重试", () => {
  initLang("en");
  const rl = (retryAfterSec?: number) => Object.assign(new Error("HTTP 429"), { rateLimited: true, retryAfterSec });

  it("退避节奏 1s/2s/4s，之后每次 4s；Retry-After 优先且单次 ≤60s", () => {
    assert.equal(backoffMs(1), 1_000);
    assert.equal(backoffMs(2), 2_000);
    assert.equal(backoffMs(3), 4_000);
    assert.equal(backoffMs(4), 4_000);
    assert.equal(backoffMs(9), 4_000);
    assert.equal(backoffMs(1, 7), 7_000);
    assert.equal(backoffMs(1, 120), 60_000);
  });

  it("429 重试后成功：节奏与提示回调正确", async () => {
    let n = 0;
    const waits: number[] = [];
    const notes: string[] = [];
    const out = await withRateLimitRetry(
      async () => {
        if (++n <= 2) throw rl();
        return "ok";
      },
      3,
      (i) => notes.push(`${i.attempt}/${i.total}/${i.sec}`),
      async (ms) => {
        waits.push(ms);
      },
    );
    assert.equal(out, "ok");
    assert.deepEqual(waits, [1_000, 2_000]);
    assert.deepEqual(notes, ["1/3/1", "2/3/2"]);
  });

  it("Retry-After 优先；耗尽后报错含已重试次数；--retry 0 不重试", async () => {
    let n = 0;
    const waits: number[] = [];
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          n++;
          throw rl(9);
        },
        3,
        undefined,
        async (ms) => {
          waits.push(ms);
        },
      ),
      /Still rate limited after 3 retries/,
    );
    assert.equal(n, 4);
    assert.deepEqual(waits, [9_000, 9_000, 9_000]);

    let m = 0;
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          m++;
          throw rl();
        },
        0,
        undefined,
        async () => {},
      ),
      /HTTP 429/,
    );
    assert.equal(m, 1);
  });

  it("非 429 错误不重试；累计等待超 60s 预算提前耗尽", async () => {
    let n = 0;
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          n++;
          throw new Error("boom");
        },
        3,
        undefined,
        async () => {},
      ),
      /boom/,
    );
    assert.equal(n, 1);

    let k = 0;
    const waits: number[] = [];
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          k++;
          throw rl(25);
        },
        5,
        undefined,
        async (ms) => {
          waits.push(ms);
        },
      ),
      /Still rate limited after 2 retries/,
    );
    assert.equal(k, 3);
    assert.deepEqual(waits, [25_000, 25_000]);
  });
});

describe("下载退避重试", () => {
  it("网络错误重试后成功；429/5xx 可重试；网络错误耗尽抛带产物去向提示", async () => {
    // 网络错误 1 次后成功，退避 1s
    let n = 0;
    const waits: number[] = [];
    const ok = await fetchWithRetry(
      "https://x/a.mp4",
      async () => {
        if (n++ === 0) throw new TypeError("fetch failed");
        return new Response("ok");
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(waits, [1_000]);

    // 429 → 重试后 200
    let m = 0;
    const r429 = await fetchWithRetry(
      "u",
      async () => (m++ === 0 ? new Response("limited", { status: 429 }) : new Response("ok")),
      async () => {},
    );
    assert.equal(r429.status, 200);

    // 5xx 重试 2 次后仍 5xx → 返回响应由调用方报 downloadFailed（不吞状态码）
    const waits5: number[] = [];
    const r5 = await fetchWithRetry(
      "u",
      async () => new Response("boom", { status: 502 }),
      async (ms) => {
        waits5.push(ms);
      },
    );
    assert.equal(r5.status, 502);
    assert.deepEqual(waits5, [1_000, 2_000]);

    // 网络错误耗尽 → 提示产物未丢、重跑命令可再下载
    await assert.rejects(
      fetchWithRetry(
        "u",
        async () => {
          throw new TypeError("fetch failed");
        },
        async () => {},
      ),
      /Download failed \(network error after 2 retries\).*rerun the same status command/s,
    );
  });
});

describe("~ 展开", () => {
  it("~/ 与裸 ~ 展开到主目录；~其它用户名明确报错；普通路径原样", () => {
    const home = os.homedir();
    assert.equal(expandHome("~/thcli-out"), path.join(home, "thcli-out"));
    assert.equal(expandHome("~"), home);
    assert.equal(expandHome("./out"), "./out");
    assert.equal(expandHome("/abs/out"), "/abs/out");
    // ~user 形式不静默展开（曾会把 ./~user 建进当前目录或错拼到主目录下）
    assert.throws(() => expandHome("~root/out"), /cross-platform|absolute path/);
  });
});

describe("+gen 子命令 apis", () => {
  it("apis 列出接口；旧名 models 不再是子命令（按接口 ID 报错并指引 apis）", () => {
    const apis = runSub(["+gen", "apis"]);
    assert.equal(apis.code, 0, apis.out);
    assert.match(apis.out, /wand\/vidu\/text-to-video/);
    const detail = runSub(["+gen", "apis", "wand/si-image/generation"]);
    assert.equal(detail.code, 0, detail.out);
    assert.match(detail.out, /seedream-image-v5\.0-pro/);
    const old = runSub(["+gen", "models"]);
    assert.notEqual(old.code, 0);
    assert.match(old.out, /\+gen apis/);
  });
});

describe("--output 防覆盖", () => {
  it("dedupePath：不撞名原样；本批/磁盘撞名依次加 -2、-3；保留原下标", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-dedupe-"));
    const free = path.join(dir, "a.txt");
    assert.equal(dedupePath(free, new Set()), free);
    // 本批（内存 Set）撞名
    assert.equal(dedupePath(free, new Set([free])), path.join(dir, "a-2.txt"));
    // 磁盘撞名：result-1.txt 已存在 → result-1-2.txt；-2 也占 → -3
    fs.writeFileSync(path.join(dir, "result-1.txt"), "old");
    assert.equal(dedupePath(path.join(dir, "result-1.txt"), new Set()), path.join(dir, "result-1-2.txt"));
    fs.writeFileSync(path.join(dir, "result-1-2.txt"), "old2");
    assert.equal(dedupePath(path.join(dir, "result-1.txt"), new Set()), path.join(dir, "result-1-3.txt"));
    // 无扩展名文件
    fs.writeFileSync(path.join(dir, "LICENSE"), "x");
    assert.equal(dedupePath(path.join(dir, "LICENSE"), new Set()), path.join(dir, "LICENSE-2"));
  });

  it("saveTexts：同目录二次写入不覆盖（缺陷场景），内容互不干扰", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-texts-"));
    const first = saveTexts(["hello"], dir, 0);
    assert.equal(path.basename(first[0]!), "result-0.txt");
    // 批量循环：第二个任务写同一目录，不再静默覆盖
    const second = saveTexts(["world"], dir, 0);
    assert.equal(path.basename(second[0]!), "result-0-2.txt");
    assert.equal(fs.readFileSync(first[0]!, "utf8"), "hello");
    assert.equal(fs.readFileSync(second[0]!, "utf8"), "world");
  });

  it("download：data URL 同目录二次写入防覆盖（重跑同一任务不丢旧产物）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-dl-"));
    const wav = "data:audio/wav;base64,UklGRg==";
    const a = await download([wav], dir);
    const b = await download([wav], dir);
    assert.equal(path.basename(a[0]!), "result-0.wav");
    assert.equal(path.basename(b[0]!), "result-0-2.wav");
    // 第三个任务多产物：撞名下标继续找空位，未撞名下标正常落位
    const c = await download([wav, wav], dir);
    assert.equal(path.basename(c[0]!), "result-0-3.wav");
    assert.equal(path.basename(c[1]!), "result-1.wav");
  });
});
