/**
 * 输出格式化的单元测试。
 *
 * 覆盖重点是本轮真实出过 bug 的地方，而不是逐个函数刷覆盖率：
 *   - pad 的 CJK 宽度与截断（表格错位的根源，且 i18n 迁移后英文更长，必须有网）
 *   - human 的小数与极小值（曾把 0.004 显示成 0）
 *   - verticalChart 的末点刻度（补位判断用了 trim 前的长度，静默失效过）
 *   - stackedChart 的堆叠顺序与不丢量（曾颜色乱跳；合并「其它」是为了柱高与汇总对得上）
 *   - printTable 不截断（曾用 pad(id, 42) 打 44 字符的 ApiKeyId，列表里的 ID 复制去
 *     key get 必然 not found——这是「命令能跑但结果不可用」，只有断言防得住）
 *   - splitCsv 按空白也拆（PowerShell 把 `--targets a,b` 送成 `"a b"`，而 key scope 是
 *     全量覆盖，拆不开就把整串当一个 ID 发出去，等于把访问范围裁错）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  displayWidth,
  human,
  pad,
  printTable,
  sparkline,
  splitCsv,
  stackedChart,
  verticalChart,
} from "../src/core/format.js";

/** 抓住 printTable 的 console.log 输出 */
function capture(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("displayWidth", () => {
  it("CJK 算 2 列，ASCII 算 1 列", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("模型"), 4);
    assert.equal(displayWidth("模型abc"), 7);
  });
});

describe("pad", () => {
  it("按显示宽度补齐，中文不会把列挤歪", () => {
    assert.equal(displayWidth(pad("abc", 10)), 10);
    assert.equal(displayWidth(pad("模型", 10)), 10);
    assert.equal(displayWidth(pad("模型abc", 10)), 10);
  });

  it("超长内容截断并标 …，且截断后仍占满列宽", () => {
    const out = pad("custom-model-b6-standard-very-long", 12);
    assert.equal(displayWidth(out), 12);
    assert.ok(out.includes("…"));
  });

  it("中文超长时不会因半个字符导致宽度算错", () => {
    // 宽度 5 装不下 3 个中文（6 列），回退一格给 … 后应恰好 5 列
    const out = pad("模型名称", 5);
    assert.equal(displayWidth(out), 5);
  });

  it("空值与 undefined 按空串处理", () => {
    assert.equal(pad(undefined, 4), "    ");
    assert.equal(pad(null, 4), "    ");
  });
});

describe("splitCsv", () => {
  it("逗号分隔拆成多值", () => {
    assert.deepEqual(splitCsv("glm-5.3,hy4-preview"), ["glm-5.3", "hy4-preview"]);
  });

  it("空白也当分隔符", () => {
    // 真实 bug：PowerShell 的 argument mode 把 `a,b` 当数组语法求值，传给原生进程时
    // 按 $OFS（默认空格）拼回单串，thcli 收到的是 `--targets "glm-5.3 hy4-preview"`。
    // 只按逗号拆会把整串当成一个 ID 发给后端，报 model(glm-5.3 hy4-preview) not found；
    // 若那串恰好是个存在的资源名，key scope 的全量覆盖就会静默把权限裁错。
    assert.deepEqual(splitCsv("glm-5.3 hy4-preview"), ["glm-5.3", "hy4-preview"]);
    assert.deepEqual(splitCsv("glm-5.3, hy4-preview"), ["glm-5.3", "hy4-preview"]);
    assert.deepEqual(splitCsv(" a ,\tb\nc "), ["a", "b", "c"]);
  });

  it("单值原样返回", () => {
    assert.deepEqual(splitCsv("ep-06frL9rc"), ["ep-06frL9rc"]);
  });

  it("空串与纯空白拆成空列表", () => {
    // key scope / key create 靠 targets.length 判断「custom 却没给目标」，
    // 这里多返回一个空串就会绕过那条校验，把空 ID 发给后端
    assert.deepEqual(splitCsv(""), []);
    assert.deepEqual(splitCsv("   "), []);
    assert.deepEqual(splitCsv(",,"), []);
  });

  it("全角逗号不拆，留给调用方校验", () => {
    // 不是遗漏：全角逗号只可能是输入错误，拆开会让一个错值变成两个错值，
    // 保持整串原样才能在报错信息里把用户真正输入的东西回显出来
    assert.deepEqual(splitCsv("glm-5.3，hy4-preview"), ["glm-5.3，hy4-preview"]);
  });
});

describe("human", () => {
  it("按量级套 K/M/B", () => {
    assert.equal(human(1234), "1.23 K");
    assert.equal(human(1_234_567), "1.23 M");
    assert.equal(human(1_234_567_890), "1.23 B");
  });

  it("整数不加小数点", () => {
    assert.equal(human(474), "474");
    assert.equal(human(0), "0");
  });

  it("小数保留 2 位（监控指标常带长小数尾）", () => {
    assert.equal(human(42.5833), "42.58");
  });

  it("小于 0.01 的值保留有效数字，不能显示成 0", () => {
    // 这是真实修过的 bug：toFixed(2) 会把 0.004 变成 "0.00"，
    // 让"有量但很小"看起来像"无量"
    assert.equal(human(0.004), "0.0040");
    assert.notEqual(human(0.004), "0.00");
    assert.ok(Number(human(0.0001)) > 0);
  });
});

describe("sparkline", () => {
  it("长度等于数据点数", () => {
    assert.equal(sparkline([1, 2, 3, 4]).length, 4);
  });

  it("有量的点至少一格，不与无量混淆", () => {
    const out = sparkline([0, 1, 100], 100);
    assert.equal(out[0], " ", "0 应是空白");
    assert.notEqual(out[1], " ", "有量就该看得见");
  });

  it("zeroMark=baseline 时零值画基线点，保证各行等长可对齐", () => {
    const out = sparkline([0, 5, 0], 5, "baseline");
    assert.equal(out[0], "·");
    assert.equal(out[2], "·");
  });

  it("共用 peak 时各行可横向比较", () => {
    const high = sparkline([100], 100);
    const low = sparkline([1], 100);
    assert.notEqual(high, low);
  });
});

describe("verticalChart", () => {
  const label = (i: number): string => `${String(i).padStart(2, "0")}:00`;
  const fmt = (v: number): string => human(v);

  it("Y 轴刻度行数固定，图形宽度随点数自适应", () => {
    const c = verticalChart([1, 2, 3], label, fmt);
    assert.equal(c.rows.length, 8);
    // 3 点 × barWidth 3 = 9 列
    assert.ok(c.axis.includes("─".repeat(9)));
  });

  it("末点必有刻度（否则读不出区间终点）", () => {
    // 真实 bug：按固定间隔从 0 起铺时，末点常落不到间隔上，
    // 图最右那根柱子没有时间标注，倒数第二个刻度看着像终点
    for (const n of [7, 12, 23, 24, 25, 37]) {
      const c = verticalChart(new Array<number>(n).fill(10), label, fmt);
      const barWidth = n <= 26 ? 3 : n <= 40 ? 2 : 1;
      const barStart = c.rows[0]!.indexOf("┤") + 1;
      const lastCol = barStart + (n - 1) * barWidth;
      assert.ok(
        c.labels.length > lastCol && c.labels.slice(lastCol).trim().length > 0,
        `${n} 点时末点应有刻度`,
      );
    }
  });

  it("每个标签都对准它那根柱子的起始列", () => {
    const n = 23;
    const c = verticalChart(new Array<number>(n).fill(10), label, fmt);
    const barWidth = 3;
    const barStart = c.rows[0]!.indexOf("┤") + 1;
    for (const m of c.labels.matchAll(/\d\d:00/g)) {
      const offset = m.index - barStart;
      assert.equal(offset % barWidth, 0, `标签 ${m[0]} 未对准柱子边界`);
    }
  });

  it("null 表示无数据，渲染为空列而非零高柱", () => {
    const c = verticalChart([null, 100], label, fmt);
    const bottom = c.rows[c.rows.length - 1]!;
    const barStart = bottom.indexOf("┤") + 1;
    assert.equal(bottom[barStart], " ", "null 列应留空");
    assert.notEqual(bottom[barStart + 3], " ", "有值列应有柱子");
  });

  it("全为 0 或空数据时不抛错", () => {
    assert.doesNotThrow(() => verticalChart([0, 0], label, fmt));
    assert.doesNotThrow(() => verticalChart([null, null], label, fmt));
  });
});

describe("stackedChart", () => {
  const label = (i: number): string => `${String(i).padStart(2, "0")}:00`;
  const fmt = (v: number): string => human(v);
  const glyph = (): string => "#";
  const plain = (_i: number, text: string): string => text;

  it("同一柱内自底向上按系列顺序堆叠，不错乱", () => {
    // 真实 bug：先算每段起止行再填，会因取整让同一柱内颜色乱跳。
    // 现在逐格判定归属，故柱内自下往上的系列下标必须单调不减。
    const series = [
      { name: "a", values: [40], total: 40 },
      { name: "b", values: [30], total: 30 },
      { name: "c", values: [30], total: 30 },
    ];
    const c = stackedChart(series, label, fmt, glyph, (i, text) => `${i}${text}`);
    const barStart = c.rows[0]!.indexOf("┤") + 1;
    const owners: number[] = [];
    for (let r = c.rows.length - 1; r >= 0; r -= 1) {
      const cell = c.rows[r]!.slice(barStart, barStart + 2);
      if (cell.trim()) {
        owners.push(Number(cell[0]));
      }
    }
    for (let i = 1; i < owners.length; i += 1) {
      assert.ok(owners[i]! >= owners[i - 1]!, `第 ${i} 格归属回退了：${owners.join(",")}`);
    }
  });

  it("有量的时间点至少画一格，占比极小也不整根消失", () => {
    const series = [
      { name: "big", values: [1000, 1], total: 1001 },
    ];
    const c = stackedChart(series, label, fmt, glyph, plain);
    const bottom = c.rows[c.rows.length - 1]!;
    const barStart = bottom.indexOf("┤") + 1;
    assert.notEqual(bottom[barStart + 3], " ", "值为 1 的点也该有一格");
  });

  it("空系列不抛错", () => {
    assert.doesNotThrow(() => stackedChart([], label, fmt, glyph, plain));
  });
});

describe("printTable", () => {
  // 真实长度：ApiKeyId 恒 44、EndpointId/ModelId 最长 37
  const LONG_ID = "ak-20260619-5a6ff8d95e82b81be3fbf523eecc919a";

  it("长 ID 完整输出，不截断", () => {
    const lines = capture(() => printTable(["NAME", "APIKEY_ID"], [["k", LONG_ID]]));
    assert.ok(lines[1]?.includes(LONG_ID), `ID 被截断了：${lines[1]}`);
    assert.ok(!lines.join("").includes("…"), "表格里不该出现省略号");
  });

  /** 末列在终端的起始列号。必须按显示宽度算——CJK 占 2 列，用字符索引会误判 */
  const lastColumnAt = (line: string): number => displayWidth(line.slice(0, line.lastIndexOf(" ") + 1));

  it("列宽取表头与内容的较大者", () => {
    const lines = capture(() => printTable(["ID", "NAME"], [["x", "a"], ["longer-value", "b"]]));
    assert.equal(
      lastColumnAt(lines[1] as string),
      lastColumnAt(lines[2] as string),
      `列未对齐：\n${lines.join("\n")}`,
    );
  });

  it("CJK 内容也能对齐", () => {
    // 中文占 2 列，若按字符数补空格，含中文的行会比纯 ASCII 行短一半
    const lines = capture(() => printTable(["ID", "STATUS"], [["a", "x"], ["中文名称", "y"]]));
    assert.equal(
      lastColumnAt(lines[1] as string),
      lastColumnAt(lines[2] as string),
      `CJK 行错位：\n${lines.join("\n")}`,
    );
  });

  it("行尾不留多余空格", () => {
    const lines = capture(() => printTable(["A", "B"], [["1", "2"]]));
    for (const line of lines) {
      assert.equal(line, line.trimEnd(), `行尾有空格：${JSON.stringify(line)}`);
    }
  });

  it("空表也只打表头，不抛错", () => {
    const lines = capture(() => printTable(["A", "B"], []));
    assert.equal(lines.length, 1);
  });
});
