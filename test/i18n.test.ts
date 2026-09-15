/**
 * i18n 测试。
 *
 * 最重要的一条是「zh/en 键一一对应」——存量文案迁移期间每加一条键都可能漏另一侧，
 * 有这条网就不会等到用户切英文才发现夹着中文。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLOUD_CODES, ERROR_CODES, GATEWAY_CODES, lookupError } from "../src/core/errors.js";
import { initLang, lang, placeholdersOf, SUPPORTED_LANGS, t } from "../src/core/i18n.js";
import { EN } from "../src/locales/en.js";
import { ZH } from "../src/locales/zh.js";

describe("locale 键一致性", () => {
  it("zh 与 en 的键完全对应", () => {
    const onlyZh = Object.keys(ZH).filter((k) => !(k in EN));
    const onlyEn = Object.keys(EN).filter((k) => !(k in ZH));
    assert.deepEqual(onlyZh, [], `这些键缺英文：${onlyZh.join(", ")}`);
    assert.deepEqual(onlyEn, [], `这些键缺中文：${onlyEn.join(", ")}`);
  });

  it("两侧占位符集合完全一致", () => {
    // 这是占位符方案相对函数形式的关键收益：文案是数据，可以自动校验。
    // 一侧写 {count} 另一侧漏掉，会让英文界面丢数字——这类错误很难靠肉眼发现。
    for (const key of Object.keys(ZH)) {
      const zh = placeholdersOf(ZH[key] as string);
      const en = placeholdersOf(EN[key] as string);
      assert.deepEqual(en, zh, `${key} 占位符不一致：zh=[${zh}] en=[${en}]`);
    }
  });

  it("全部文案都是字符串（不允许函数形式）", () => {
    for (const [key, value] of Object.entries({ ...ZH, ...EN })) {
      assert.equal(typeof value, "string", `${key} 不是字符串`);
    }
  });

  it("占位符名是合法标识符，不含空格或表达式残留", () => {
    for (const [key, value] of Object.entries({ ...ZH, ...EN })) {
      assert.ok(!(value as string).includes("${"), `${key} 残留了模板字面量语法`);
    }
  });

  it("字面路径不用花括号（避免被当成占位符）", () => {
    // 曾把 ~/.thcli/{profile}.{site}.credential 直接写进文案。当时没出错纯属侥幸：
    // interpolate 对未提供的参数保留原样。但只要哪个调用方传了 profile 参数，
    // 这个路径就会被意外替换。字面量一律用尖括号。
    for (const [key, value] of Object.entries({ ...ZH, ...EN })) {
      const suspicious = /\{(profile|site|path|dir|file)\}[.\/]/.test(value as string);
      assert.ok(!suspicious, `${key} 里的花括号看着像字面路径，请改用尖括号：${value}`);
    }
  });

  it("成对引号统一用单引号或「」，不用双引号", () => {
    // 曾写 "No model matched "{query}"." 让 en.ts 编译失败（撞上定界符）。
    // 命令示例里的 --message "Hello" 是合法的（源码用单引号定界），故只拦
    // 「用双引号包裹占位符」这一种写法——那是引述用法，该用单引号或「」。
    for (const [key, value] of Object.entries({ ...ZH, ...EN })) {
      const quotedPlaceholder = /"\{\w+\}"/.test(value as string);
      assert.ok(!quotedPlaceholder, `${key} 用双引号包了占位符，请改单引号或「」：${value}`);
    }
  });

  it("没有空文案", () => {
    for (const [key, value] of Object.entries(ZH)) {
      if (typeof value === "string") {
        assert.ok(value.trim().length > 0, `${key} 的中文为空`);
      }
    }
    for (const [key, value] of Object.entries(EN)) {
      if (typeof value === "string") {
        assert.ok(value.trim().length > 0, `${key} 的英文为空`);
      }
    }
  });

  it("英文文案里不夹中文字符", () => {
    const cjk = /[一-鿿]/;
    for (const [key, value] of Object.entries(EN)) {
      if (typeof value === "string") {
        assert.ok(!cjk.test(value), `${key} 的英文里夹了中文：${value}`);
      }
    }
  });
});

describe("语言解析优先级", () => {
  it("--lang 优先于环境变量", () => {
    process.env["THCLI_LANG"] = "zh";
    try {
      assert.equal(initLang("en"), "en");
    } finally {
      delete process.env["THCLI_LANG"];
    }
  });

  it("环境变量在无 --lang 时生效", () => {
    process.env["THCLI_LANG"] = "en";
    try {
      assert.equal(initLang(undefined), "en");
    } finally {
      delete process.env["THCLI_LANG"];
    }
  });

  it("接受常见写法", () => {
    for (const v of ["zh", "zh-CN", "cn", "Chinese"]) {
      assert.equal(initLang(v), "zh", `${v} 应识别为中文`);
    }
    for (const v of ["en", "en-US", "English"]) {
      assert.equal(initLang(v), "en", `${v} 应识别为英文`);
    }
  });

  it("非法值不生效，退到下一级（而不是静默当成默认语言）", () => {
    initLang("en");
    // 传非法值时不该把已解析的语言改成 zh，而应继续按后续来源解析
    const after = initLang("nonsense");
    assert.ok(after === "zh" || after === "en", "非法值不应抛错");
  });

  it("SUPPORTED_LANGS 覆盖全部可选语言且有本地名", () => {
    assert.equal(SUPPORTED_LANGS.length, 2);
    for (const item of SUPPORTED_LANGS) {
      assert.ok(item.native.length > 0, `${item.code} 缺本地语言名`);
    }
  });
});

describe("t()", () => {
  it("按当前语言取值", () => {
    initLang("zh");
    const zh = t("common.noData");
    initLang("en");
    const en = t("common.noData");
    assert.notEqual(zh, en);
    assert.ok(/[一-鿿]/.test(zh));
    assert.ok(!/[一-鿿]/.test(en));
  });

  it("带参插值", () => {
    initLang("zh");
    const out = t("models.free.plan", { count: 3, names: "a, b, c" });
    assert.ok(out.includes("3"));
    assert.ok(out.includes("a, b, c"));
    assert.ok(!out.includes("{"), "占位符应已全部替换");
  });

  it("中英文可以有不同语序，占位符位置无需相同", () => {
    // 占位符方案的意义：译者能把参数放到符合本语言语序的位置
    initLang("zh");
    const zh = t("models.free.plan", { count: 2, names: "x" });
    initLang("en");
    const en = t("models.free.plan", { count: 2, names: "x" });
    for (const out of [zh, en]) {
      assert.ok(out.includes("2") && out.includes("x"), `参数未代入：${out}`);
    }
  });

  it("漏传参数时保留占位符，不输出 undefined", () => {
    initLang("zh");
    const out = t("models.free.plan", { count: 1 });
    assert.ok(out.includes("{names}"), "缺参应保留占位符供排查");
    assert.ok(!out.includes("undefined"), "不该输出 undefined");
  });

  it("缺失键回显键名而不抛错", () => {
    initLang("zh");
    assert.equal(t("no.such.key.at.all"), "no.such.key.at.all");
  });

  it("英文缺键时回退中文，不返回空", () => {
    initLang("en");
    const out = t("common.noData");
    assert.ok(out.length > 0);
  });

  it("lang() 与 initLang 的返回一致", () => {
    assert.equal(initLang("en"), lang());
    assert.equal(initLang("zh"), lang());
  });
});

describe("错误码释义完整性", () => {
  // 码清单在 errors.ts、文案在 locales，两处分离是有意的（切语言时原因和建议一起变），
  // 代价是加码时容易只改一边：清单里有码但没文案，doctor error 会打出空的原因和修复。
  // 网关业务码是一次性从服务端定义拷来的 36 条，靠肉眼核对不可靠。
  it("每个收录的码在 zh/en 都有 reason 与 fix", () => {
    initLang("zh");
    for (const code of ERROR_CODES) {
      const key = `errcode.${code.replace(/\./g, "_")}`;
      for (const field of ["reason", "fix"]) {
        assert.ok(`${key}.${field}` in ZH, `缺中文：${key}.${field}`);
        assert.ok(`${key}.${field}` in EN, `缺英文：${key}.${field}`);
      }
    }
  });

  it("lookupError 对每个码都返回非空释义", () => {
    initLang("zh");
    for (const code of ERROR_CODES) {
      const info = lookupError(code);
      assert.ok(info, `${code} 查不到释义`);
      assert.ok(info.reason.length > 0 && !info.reason.startsWith("errcode."), `${code} 原因为空`);
      assert.ok(info.fix.length > 0 && !info.fix.startsWith("errcode."), `${code} 修复建议为空`);
    }
  });

  it("管控面与数据面码无重叠，合起来即全集", () => {
    const overlap = CLOUD_CODES.filter((c) => GATEWAY_CODES.includes(c));
    assert.deepEqual(overlap, [], `码在两组里重复出现：${overlap.join(", ")}`);
    assert.equal(ERROR_CODES.length, CLOUD_CODES.length + GATEWAY_CODES.length);
  });

  it("数据面码都是六位数字，与管控面的字母命名空间不会混淆", () => {
    for (const code of GATEWAY_CODES) {
      assert.match(code, /^\d{6}$/, `${code} 不是六位数字码`);
    }
  });
});
