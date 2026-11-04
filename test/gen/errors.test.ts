/**
 * gen-errors.ts：厂商错误码（《厂商错误码说明》）各厂商错误字段的定位与解析、码表查询、展示行，
 * 以及平台网关错误在 +gen 场景下的补充（401007/401008 → models activate、上游码、按报错原文的建议）。
 * 响应样例取自文档里的示例结构。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diagnoseCommandOf, extractErrorDetail, gatewayErrorLines, lookupError } from "../../src/core/errors.js";
import { familyOf } from "../../src/core/gen-registry.js";
import { initLang } from "../../src/core/i18n.js";
import {
  extractVendorError,
  findVendorErrors,
  genErrorLines,
  genFixOf,
  lookupVendorError,
  messageFixOf,
  vendorCodes,
  vendorErrorLines,
  VENDORS,
} from "../../src/core/gen-errors.js";

describe("厂商错误字段定位（提交期 / 生成期）", () => {
  it("PixVerse：ErrCode≠0 为提交期错误；Resp.status 7/8 为生成期失败；ErrCode=0 且运行中不算错误", () => {
    assert.deepEqual(extractVendorError("pixverse", { ErrCode: 400017, ErrMsg: "invalid param", Resp: null, request_id: "r" }), {
      vendor: "pixverse",
      code: "400017",
      message: "invalid param",
    });
    assert.equal(extractVendorError("pixverse", { ErrCode: 0, ErrMsg: "Success", Resp: { status: 7 } })?.code, "status:7");
    assert.equal(extractVendorError("pixverse", { ErrCode: 0, ErrMsg: "Success", Resp: { status: 8 } })?.code, "status:8");
    assert.equal(extractVendorError("pixverse", { ErrCode: 0, ErrMsg: "success", Resp: { video_id: "v" } }), undefined);
  });

  it("Kling：code≠0 为提交期错误；data[].status=failed 为生成期失败（取 task_status_msg / message）", () => {
    assert.deepEqual(extractVendorError("kling", { code: 1201, message: "bad", request_id: "" }), { vendor: "kling", code: "1201", message: "bad" });
    assert.deepEqual(extractVendorError("kling", { code: 0, data: [{ status: "failed", message: "risk control" }] }), {
      vendor: "kling",
      message: "risk control",
    });
    assert.equal(extractVendorError("kling", { code: 0, data: { status: "failed", task_status_msg: "m" } })?.message, "m");
    assert.equal(extractVendorError("kling", { code: 0, message: "SUCCEED", data: { id: "t", status: "submitted" } }), undefined);
  });

  it("Vidu：err_code 非空即失败；空串为成功", () => {
    assert.deepEqual(extractVendorError("vidu", { id: "1", state: "failed", err_code: "AuditSubmitIllegal" }), { vendor: "vidu", code: "AuditSubmitIllegal" });
    assert.equal(extractVendorError("vidu", { id: "1", state: "success", err_code: "" }), undefined);
  });

  it("MiniMax：base_resp.status_code≠0 为失败", () => {
    assert.deepEqual(extractVendorError("minimax", { base_resp: { status_code: 1026, status_msg: "sensitive" } }), {
      vendor: "minimax",
      code: "1026",
      message: "sensitive",
    });
    assert.equal(extractVendorError("minimax", { task_id: "t", base_resp: { status_code: 0, status_msg: "success" } }), undefined);
  });

  it("MiniMax H3：平台侧顶层 error.type；厂商侧 task.error.code；带 code 的平台网关错误不在这里认", () => {
    assert.deepEqual(extractVendorError("minimax-h3", { error: { type: "rate_limit_error", message: "slow down" } }), {
      vendor: "minimax-h3",
      code: "rate_limit_error",
      message: "slow down",
    });
    assert.deepEqual(extractVendorError("minimax-h3", { task: { status: "failed", error: { code: "internal_error", message: "x" } } }), {
      vendor: "minimax-h3",
      code: "internal_error",
      message: "x",
    });
    assert.equal(extractVendorError("minimax-h3", { error: { code: "401002", type: "gateway_error", message: "m" } }), undefined);
  });
});

describe("厂商错误码表", () => {
  it("文档里的码全部收录（PixVerse 27 + 平台侧 2 + 生成期 2 / Kling 21 / Vidu 39 / MiniMax 16 / H3 5）", () => {
    assert.equal(vendorCodes("pixverse").length, 31);
    assert.equal(vendorCodes("kling").length, 21);
    assert.equal(vendorCodes("vidu").length, 39);
    assert.equal(vendorCodes("minimax").length, 16);
    assert.equal(vendorCodes("minimax-h3").length, 5);
  });

  it("每个码都有说明与修复建议（按类别或专门覆盖），中英文都不为空", () => {
    for (const v of VENDORS) {
      for (const code of vendorCodes(v)) {
        const info = lookupVendorError(v, code)!;
        assert.ok(info.reason && info.fix && !info.fix.startsWith("vendor.fix."), `${v} ${code}`);
      }
    }
  });

  it("同值码跨厂商全部列出；字符串码大小写不敏感", () => {
    assert.deepEqual(findVendorErrors("1002").map((x) => x.vendor), ["kling", "minimax"]);
    assert.equal(lookupVendorError("vidu", "quotaexceeded")?.code, "QuotaExceeded");
    assert.equal(lookupVendorError("kling", "9999"), undefined);
  });

  it("有专门建议的码用专门建议（MiniMax 2056 → 等下一时间段）", () => {
    assert.match(lookupVendorError("minimax", "2056")!.fix, /下一个时间段|next period/);
  });
});

describe("厂商错误展示", () => {
  it("已收录：厂商原文 + 厂商错误码说明 + 修复建议 + Request ID；鉴权类附诊断命令", () => {
    const lines = vendorErrorLines({ vendor: "kling", code: "1000", message: "auth failed" }, "rid", "thcli doctor model --id kling-video-v3");
    assert.ok(lines.some((l) => l.includes("auth failed")));
    assert.ok(lines.some((l) => l.includes("Kling 1000")));
    assert.ok(lines.some((l) => l.includes("thcli doctor model --id kling-video-v3")));
    assert.equal(lines.at(-1), "Request ID: rid");
    const param = vendorErrorLines({ vendor: "kling", code: "1201", message: "x" }, "rid", "thcli doctor model --id m");
    assert.ok(!param.some((l) => l.includes("thcli doctor model --id")), "参数类不附诊断");
  });

  it("未收录的码：标注未收录并给出查表命令", () => {
    const lines = vendorErrorLines({ vendor: "kling", code: "9999", message: "x" }, undefined);
    assert.ok(lines.some((l) => l.includes("9999")));
    assert.ok(lines.some((l) => l.includes("--vendor kling")));
  });

  it("HTTP 非 2xx 且是厂商信封（无平台业务码）：按厂商表展示；平台业务码优先", () => {
    const vendorLines = genErrorLines({ ErrCode: 500054, ErrMsg: "Content moderation failure" }, "r", { vendor: "pixverse" });
    assert.ok(vendorLines.some((l) => l.includes("PixVerse 500054")));
    const platformLines = genErrorLines({ error: { code: "401002", message: "m" } }, "r", { vendor: "pixverse" });
    assert.ok(platformLines.some((l) => l.includes("401002")) && !platformLines.some((l) => l.includes("PixVerse")));
  });

  it("上游错误透传 upstream_code（能对上厂商表时给说明）；限流带 Retry-After", () => {
    const lines = genErrorLines(
      { error: { code: "502001", message: "upstream", source: "upstream", upstream_code: "1303", upstream_status: 429 } },
      "r",
      { vendor: "kling", retryAfter: "30" },
    );
    assert.ok(lines.some((l) => l.includes("1303") && l.includes("429")));
    assert.ok(lines.some((l) => l.includes("Kling 1303")));
    assert.ok(lines.some((l) => l.includes("30")));
  });

  it("Kling「PAR should be 1:1」：按报错原文给转码命令（厂商信封、任务失败、网关包装三条路径）", () => {
    assert.match(messageFixOf("kling", "Invalid video: PAR should be 1:1")!, /setsar=1/);
    assert.equal(messageFixOf("vidu", "PAR should be 1:1"), undefined);
    assert.equal(messageFixOf("kling", "other error"), undefined);
    const fixLine = (lines: string[]): string => lines.find((l) => l.includes("setsar=1")) ?? "";
    assert.ok(fixLine(vendorErrorLines({ vendor: "kling", code: "1201", message: "PAR should be 1:1" }, "r")));
    assert.ok(fixLine(vendorErrorLines({ vendor: "kling", message: "PAR should be 1:1" }, "r")));
    const wrapped = genErrorLines(
      { error: { code: "502001", message: "PAR should be 1:1", message_zh: "后端语音服务返回业务错误", source: "upstream", upstream_code: "1201", upstream_status: 400 } },
      "r",
      { vendor: "kling" },
    );
    assert.ok(fixLine(wrapped));
    assert.equal(wrapped.filter((l) => l.includes("setsar=1")).length, 1, "建议只出现一次");
  });
});

describe("模型族的厂商标注", () => {
  it("第三方模型都标注了厂商，平台自研模型不标", () => {
    const expect: Array<[string, string | undefined]> = [
      ["pixverse-video-v6.0", "pixverse"],
      ["kling-video-v3", "kling"],
      ["vidu-video-q3-pro", "vidu"],
      ["minimax-video-v2.3", "minimax"],
      ["minimax-video-h3", "minimax-h3"],
      ["hy-image-v3", undefined],
      ["seedream-image-v5.0-pro", undefined],
    ];
    for (const [model, vendor] of expect) assert.equal(familyOf(model)?.vendor, vendor, model);
  });
});

describe("+gen 场景的修复建议", () => {
  it("401007/401008 给 models activate <模型>，其它码不变", () => {
    assert.match(genFixOf("401008", "kling-video-v3")!, /models activate kling-video-v3/);
    assert.match(lookupError("401008")!.fix, /endpoint postpaid on/);
    assert.equal(genFixOf("401002", "x"), undefined);
    const lines = genErrorLines({ error: { code: "401007", message: "m", message_zh: "中" } }, "rid", { genModel: "seedream-image-v5.0-pro" });
    assert.ok(lines.some((l) => /models activate seedream-image-v5\.0-pro/.test(l)));
    assert.equal(lines.at(-1), "Request ID: rid");
    assert.equal(genErrorLines("<html>oops</html>", undefined).length, 2, "非 JSON：说明 + Request ID，无错误码行");
  });
});

describe("报错时附 doctor 诊断命令", () => {
  it("只对 Key / 范围 / 后付费类码附上", () => {
    assert.equal(diagnoseCommandOf("m"), "thcli doctor model --id m");
    const diagnose = "thcli doctor model --id m";
    for (const code of ["401002", "401006", "401007", "401008", "403002"]) {
      const lines = gatewayErrorLines({ error: { code } }, "r", { diagnose });
      assert.ok(lines.some((l) => l.includes(diagnose)), code);
    }
    const other = gatewayErrorLines({ error: { code: "429001" } }, "r", { diagnose });
    assert.ok(!other.some((l) => l.includes(diagnose)), "限流类不附诊断");
    const none = gatewayErrorLines({ error: { code: "401002" } }, "r");
    assert.ok(!none.some((l) => l.includes("thcli doctor model --id")), "不传 diagnose 时不附（+chat）");
  });

  it("401006 的修复建议包含 Key 范围不含模型这一原因（网关对范围外模型返回 401006 而非 403002）", () => {
    assert.match(lookupError("401006")!.fix, /key scope/);
    assert.match(lookupError("401002")!.fix, /key enable/);
  });

  it("401001 的修复命令是 chat-config，不再是不存在的 auth set --type", () => {
    const fix = lookupError("401001")!.fix;
    assert.match(fix, /chat-config set --type th/);
    assert.doesNotMatch(fix, /auth set/);
  });
});

describe("网关错误说明：译文笼统时附上游原文（502001 缺陷回归）", () => {
  // 缺陷场景：长文本 TTS 走 hex 输出被上游拒，message_zh 是笼统的「后端语音服务返回业务错误」，
  // 原文「response size too large … please set Output.Type=url」才是排障线索，不能被译文折叠掉
  it("中文环境：两者并存且不同 → 译文（原文：…）；缺失或相同则不附", () => {
    initLang("zh");
    assert.equal(
      extractErrorDetail({ error: { code: "502001", message: "response size too large for base64 output, please set Output.Type=url", message_zh: "后端语音服务返回业务错误" } }),
      "后端语音服务返回业务错误（原文：response size too large for base64 output, please set Output.Type=url）",
    );
    assert.equal(extractErrorDetail({ error: { message: "only english" } }), "only english");
    assert.equal(extractErrorDetail({ error: { message: "same", message_zh: "same" } }), "same");
    assert.equal(extractErrorDetail({ error: { message: "fallback", message_zh: "" } }), "fallback", "空译文按缺失处理，回退原文（旧行为会返回空串）");
    assert.equal(extractErrorDetail("plain text"), "plain text");
  });

  it("英文环境：主显原文，不附中文译文", () => {
    initLang("en");
    assert.equal(extractErrorDetail({ error: { message: "m", message_zh: "中" } }), "m");
    assert.equal(extractErrorDetail({ error: { message_zh: "中" } }), "中");
  });

  it("502001 的修复建议含 --output-format url", () => {
    assert.match(lookupError("502001")!.fix, /--output-format url/);
  });
});
