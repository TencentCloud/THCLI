/**
 * 响应归一化：各族 parse 钩子对官方文档示例响应 / 真实响应形状的归一行为。
 * 用例素材：官方调用指南的示例响应 + 已观察到的真实响应（注明出处）。
 * 与 registry.test.ts 的分工：那边管「发出去的请求」（注册表契约 / 校验 / 参数），
 * 这边管「回来的响应」（state / urls / extraUrls / texts / meta / error）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { apiOf, familyOf, normalizeState } from "../../src/core/gen-registry.js";

const ep = (id: string) => apiOf(id)!;
const param = (id: string, field: string) => ep(id).params.find((p) => p.path === field)!;

describe("响应归一化（用文档示例响应）", () => {
  it("同步：Hy-Image-3.0 的 data[].url", () => {
    const r = familyOf("hy-image-v3")!.parse({ data: [{ url: "https://r/1.png" }] });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://r/1.png"]]);
  });

  it("同步：Hy-Image-3.5 失败帧带 error", () => {
    const r = familyOf("hy-image-v3.5-preview")!.parse({ choices: [{ delta: {}, finish_reason: "error" }], error: { message: "input moderation rejected" } });
    assert.equal(r.state, "failed");
    assert.equal(r.error, "input moderation rejected");
  });

  it("PixVerse 的数字状态：1 成功 / 5 生成中 / 7 审核失败", () => {
    const f = familyOf("pixverse-video-v6.0")!;
    assert.equal(f.parse({ Resp: { status: 1, url: "u" } }).state, "succeeded");
    assert.equal(f.parse({ Resp: { status: 5 } }).state, "running");
    assert.equal(f.parse({ Resp: { status: 7 }, ErrMsg: "audit" }).state, "failed");
    assert.equal(f.taskIdOf!({ Resp: { video_id: "vid" } }), "vid");
  });

  it("Kling 视频查询：data 是数组，结果在 outputs[].url", () => {
    const r = familyOf("kling-video-v3")!.parse({ code: 0, data: [{ status: "succeeded", outputs: [{ url: "https://v.mp4" }] }] });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://v.mp4"]]);
  });

  it("Kling 视频失败：原因在 data[].message（文档 1323 行）", () => {
    const r = familyOf("kling-video-v3")!.parse({ code: 0, data: [{ status: "failed", message: "内容审核未通过" }] });
    assert.equal(r.state, "failed");
    assert.match(r.error ?? "", /内容审核未通过/);
  });

  it("seedream b64_json：按 output_format 拼 data URL；url 形式优先", () => {
    const f = familyOf("seedream-image-v5.0-pro")!;
    assert.deepEqual(f.parse({ data: [{ b64_json: "QUJD", output_format: "png" }] }).urls, ["data:image/png;base64,QUJD"]);
    assert.match(f.parse({ data: [{ b64_json: "QUJD", output_format: "jpeg" }] }).urls[0]!, /^data:image\/jpeg;base64,/);
    assert.deepEqual(f.parse({ data: [{ url: "https://s/0.png" }, { b64_json: "QUJD" }] }).urls, ["https://s/0.png"]);
  });

  it("wand-video：return_last_frame 时尾帧在 extraUrls（文档 338-339 行）", () => {
    const r = familyOf("wand-vega-video-1.0-lite")!.parse({ status: "succeeded", content: { video_url: "https://w.mp4", last_frame_url: "https://w-last.png" } });
    assert.deepEqual([r.state, r.urls, r.extraUrls], ["succeeded", ["https://w.mp4"], ["https://w-last.png"]]);
  });

  it("vidu-video：封面在 creations[].cover_url，放 extraUrls（文档 566 行）", () => {
    const r = familyOf("vidu-video-q3-turbo")!.parse({ state: "success", creations: [{ url: "https://v.mp4", cover_url: "https://c.jpg" }] });
    assert.deepEqual([r.state, r.urls, r.extraUrls], ["succeeded", ["https://v.mp4"], ["https://c.jpg"]]);
  });

  it("Kling 组图：images 为空，结果在 task_result.series_images[].url（真实响应）", () => {
    const r = familyOf("kling-image-v3-omni")!.parse({
      code: 0,
      data: { task_status: "succeed", task_result: { images: [], result_type: "series", series_images: [{ index: 0, url: "https://s/0.png" }, { index: 1, url: "https://s/1.png" }] } },
    });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://s/0.png", "https://s/1.png"]]);
  });

  it("Kling 生图水印版本：watermark_info.enabled=true 时 watermark_url 进 extraUrls", () => {
    const r = familyOf("kling-image-v3")!.parse({
      data: { task_status: "succeed", task_result: { images: [{ url: "https://x/1.png", watermark_url: "https://x/1-wm.png" }] } },
    });
    assert.deepEqual([r.state, r.urls, r.extraUrls], ["succeeded", ["https://x/1.png"], ["https://x/1-wm.png"]]);
  });

  it("hy-3d result_format 枚举为大写（服务端拒收小写 stl）", () => {
    assert.deepEqual(param("api/3d/submit", "result_format").choices, ["STL", "USDZ", "FBX", "OBJ", "GLB", "MP4"]);
  });

  it("MiniMax H3：task.status / task.content.url", () => {
    const r = familyOf("minimax-video-h3")!.parse({ task: { status: "succeeded", content: { url: "https://m.mp4" } } });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://m.mp4"]]);
  });

  it("MiniMax H3 失败：原因在 task.error.message / code（文档 546-548 行）", () => {
    const r = familyOf("minimax-video-h3")!.parse({ task: { status: "failed", error: { code: 3000, message: "内容不合规" } } });
    assert.equal(r.state, "failed");
    assert.match(r.error ?? "", /内容不合规.*3000/);
  });

  it("混元 3D：模型文件 + 预览图", () => {
    const r = familyOf("hy-3d-3.1")!.parse({
      status: "completed",
      data: [{ type: "glb", url: "https://a.glb", preview_image_url: "https://a.png" }],
    });
    assert.deepEqual([r.state, r.urls, r.extraUrls], ["succeeded", ["https://a.glb"], ["https://a.png"]]);
  });

  it("状态枚举归一；表外值按进行中处理（宁可多轮询，不误报）；unknown 例外按失败（文档枚举，Hy 世界模型）", () => {
    for (const [raw, want] of [["succeed", "succeeded"], ["Success", "succeeded"], ["completed", "succeeded"], ["queueing", "queued"], ["in_progress", "running"], ["preparing", "running"], ["cancelled", "failed"], ["unknown", "failed"], ["weird", "running"]] as const) {
      assert.equal(normalizeState(raw), want, raw);
    }
  });

  it("ASR 同步响应（带 id 字段的网关真实形状）：文本 + 字幕 URL 归一", () => {
    const r = familyOf("hy-asr-3.0-preview")!.parse({
      id: "th_..._asrproxy_...",
      status: "completed",
      output: { text: "转写正文", subtitle_url: "https://x/out.srt", source: "zh" },
    });
    assert.deepEqual([r.state, r.texts, r.urls], ["succeeded", ["转写正文"], ["https://x/out.srt"]]);
    assert.deepEqual(r.meta, { language: "zh" });
    assert.equal(ep("wand/asrproxy/sync_transcribe").sync, true, "同步直转是同步接口");
    assert.equal(ep("wand/asrproxy/async_create").sync, false);
  });

  it("ASR 异步查询：queued / in_progress 是进行中（还没有 output）；completed 无结果视为失败", () => {
    const f = familyOf("hy-asr-3.0-preview")!;
    assert.equal(f.parse({ id: "t", status: "queued" }).state, "queued");
    assert.equal(f.parse({ id: "t", status: "in_progress" }).state, "running");
    assert.equal(f.parse({ status: "failed", error: { message: "bad audio" } }).error, "bad audio");
    assert.equal(f.parse({ status: "completed", output: {} }).state, "failed");
  });

  it("Tenlai 异步 ASR：output.text 转写 + audio_duration 元数据；数字任务 id、查询走 POST body（与 wand/asrproxy 的 GET 不同）", () => {
    const f = familyOf("tenlai-asr-v1.0")!;
    const r = f.parse({ request_id: "r", id: 17256336078, status: "completed", output: { text: "转写正文" }, audio_duration: 30 });
    assert.deepEqual([r.state, r.texts, r.urls], ["succeeded", ["转写正文"], []]);
    assert.deepEqual(r.meta, { audio_duration: "30" });
    assert.equal(f.parse({ id: 1, status: "queued" }).state, "queued");
    assert.equal(f.parse({ id: 1, status: "in_progress" }).state, "running");
    assert.equal(f.parse({ id: 1, status: "failed", error: { message: "bad audio" } }).error, "bad audio");
    assert.equal(f.parse({ id: 1, status: "completed", output: {} }).state, "failed");
    assert.equal(f.taskIdOf!({ id: 17256336078 }), "17256336078", "数字 id 归一为字符串");
    assert.deepEqual(f.query!("tenlai-asr-v1.0", "17256336078"), {
      method: "POST",
      path: "/v1/tenlai/asrproxy/describe_task_status",
      body: { model: "tenlai-asr-v1.0", task_id: 17256336078 },
    });
  });

  it("TTS：hex 音频转 data URL；MiniMax base_resp 非 0 视为失败", () => {
    const f = familyOf("minimax-speech-2.8-hd")!;
    const good = f.parse({ data: { audio: "616263" }, extra_info: { audio_format: "wav" } });
    assert.equal(good.state, "succeeded");
    assert.equal(good.urls[0], `data:audio/wav;base64,${Buffer.from("616263", "hex").toString("base64")}`);

    const fail = f.parse({ base_resp: { status_code: 1002, status_msg: "参数错误" }, data: { audio: "616263" } });
    assert.equal(fail.state, "failed");
    assert.match(fail.error ?? "", /参数错误/);
  });

  it("克隆 / 设计：voice_id 进 meta；Mureka：choices 多条 URL", () => {
    const c = familyOf("minimax-voice-clone")!.parse({ voice_id: "custom123", demo_audio: "https://x/d.mp3" });
    assert.deepEqual([c.state, c.meta], ["succeeded", { voice_id: "custom123" }]);

    const m = familyOf("mureka-music-v9")!.parse({ choices: [{ url: "https://x/1.mp3" }, { url: "https://x/2.mp3" }] });
    assert.deepEqual(m.urls, ["https://x/1.mp3", "https://x/2.mp3"]);
  });

  it("配音查询：output.result_url", () => {
    const r = familyOf("wand-dubbing-clone-v2")!.parse({ status: "completed", output: { result_url: "https://x/out.mp4" } });
    assert.deepEqual([r.state, r.urls], ["succeeded", ["https://x/out.mp4"]]);
  });

  it("世界全景：status 非 succeeded 即失败；SR 图为主、封面为附属", () => {
    const f = familyOf("hy-world2-panorama")!;
    assert.equal(f.parse({ status: "failed" }).state, "failed");
    const r = f.parse({ status: "succeeded", data: [{ super_resolution_image_url: "https://x/sr.png", cover_image_url: "https://x/cover.png" }] });
    assert.deepEqual([r.state, r.urls, r.extraUrls], ["succeeded", ["https://x/sr.png"], ["https://x/cover.png"]]);
  });

  it("世界场景：多产物归一（模型文件 + 预览图 + 元数据）", () => {
    const r = familyOf("hy-world2-scene")!.parse({
      status: "succeeded",
      data: [{ scene_url: "https://x/a.spz", image_url: "https://x/p.png", position_info: '{"x":1}', air_wall: [] }],
    });
    assert.deepEqual([r.state, r.urls, r.extraUrls], ["succeeded", ["https://x/a.spz"], ["https://x/p.png"]]);
    assert.deepEqual(r.meta, { position_info: '{"x":1}', air_wall: "[]" });
  });
});
