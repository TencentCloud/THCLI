import { t } from "./i18n.js";

/**
 * 输出格式化共用件：定宽列、CSV 拆分、JSON 数组参数解析、枚举翻译。
 */

/** CJK 及全角字符范围，用于计算终端显示宽度 */
const CJK_PATTERN = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

/** 一个字符占几列：CJK 及全角标点占 2 列 */
function charWidth(ch: string): number {
  return CJK_PATTERN.test(ch) ? 2 : 1;
}

/** 字符串在终端占几列（CJK 算 2 列），用于自适应列宽 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charWidth(ch);
  }
  return width;
}

/**
 * 按显示宽度左对齐成定宽列。
 *
 * 超长内容必须截断——否则它会把本行后续所有列一起挤歪，整张表就散了
 * （模型名/端点 ID 经常超长，中文名尤其容易）。截断处标 … 提示有省略。
 */
export function pad(value: unknown, width: number): string {
  const text = value === undefined || value === null ? "" : String(value);

  let displayWidth = 0;
  let kept = "";
  for (const ch of text) {
    const w = charWidth(ch);
    if (displayWidth + w > width) {
      // 放不下了：回退一格给省略号，保证整列刚好占满 width
      while (displayWidth + 1 > width && kept.length > 0) {
        const last = [...kept].pop() as string;
        kept = kept.slice(0, -last.length);
        displayWidth -= charWidth(last);
      }
      return kept + "…" + " ".repeat(Math.max(0, width - displayWidth - 1));
    }
    kept += ch;
    displayWidth += w;
  }
  return text + " ".repeat(Math.max(0, width - displayWidth));
}

/**
 * 把逗号或空白分隔的字符串拆成列表，用于 ModelIds/Tags/IpWhitelist 等多值参数。
 *
 * 空白也当分隔符：PowerShell 的 argument mode 把 `a,b` 当数组语法求值，传给原生
 * 进程时按 $OFS（默认空格）拼回单个字符串，于是 `--targets a,b` 到达时已是 `"a b"`。
 * 这些参数收的都是 ID/类型名/IP，合法值不含空白，按空白拆不会误伤。
 */
export function splitCsv(value: string): string[] {
  return value.split(/[\s,]+/).filter(Boolean);
}

/**
 * 解析 JSON 数组参数（--bindings/--quotas/--quotas_desired）。
 * 解析失败明确报错，不把非法输入透传给云 API。
 */
export function parseJsonList(label: string, raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${t("json.notArray", { label, message: (err as Error).message })}\n` +
        t("json.rawInput", { raw }),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(t("json.mustBeArray", { label, actual: typeof parsed }));
  }
  return parsed;
}

/**
 * 大数字转人类可读单位，用于 token 计数。
 *
 * 小于 1000 时保留小数——套餐的 TotalUsed 可能是 2.58079 这种值，截断成 "2"
 * 会让"用了一点点"看起来像整整 2 个 token。
 */
export function human(value: number): string {
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)} B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(2)} M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(2)} K`;
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  // 小数保留 2 位就够读（TPM、平均 token 这类监控指标常带长小数尾）。
  // 但小于 0.01 的值四舍五入会变成 0，"有量"被显示成"无量"，故这类保留有效数字。
  return Math.abs(value) < 0.01 ? value.toPrecision(2) : value.toFixed(2);
}

/** 纵向柱状图的高度（行数）。8 行既能看出形状，4 个指标也还能一屏看完 */
const CHART_HEIGHT = 8;

/** 八分之一格块，用于柱顶的小数部分，让相近高度不至于完全一样 */
const EIGHTH_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** 纵向柱状图的一次渲染结果，行已含 Y 轴刻度 */
export interface ChartLines {
  /** 图形主体，每行形如 `  81.3M ┤ ▂█▅` */
  rows: string[];
  /** X 轴横线 */
  axis: string;
  /** X 轴时间标签行 */
  labels: string;
}

/**
 * 铺 X 轴时间标签。
 *
 * 标签比一列宽得多，故每隔若干个数据点才标一个，间隔按"标签占几列"换算成点数，
 * 否则相邻标签互相覆盖。
 *
 * 从**末点倒推**着选要标的点：若从 0 起按固定间隔铺，末点常落不到间隔上，图最
 * 右那根柱子就没有刻度，而倒数第二个刻度看着像终点——读图的人会以为区间在那里
 * 结束（实测 23 点数据时末点 00:00 无刻度、末刻度停在 23:00，让人误判没跨日）。
 *
 * 标签一律画在自己那根柱子的起始列上，不做右对齐：挪动会让标签指向错误的柱子。
 * 末点标签（5 列）必然比柱宽（1~3 列）宽，会多探出 2~4 列——这是几何必然，
 * 对准柱子比"不超出轴线"重要。
 */
function buildAxisLabels(
  points: number,
  barWidth: number,
  gutter: number,
  labelAt: (index: number) => string,
): string {
  const sample = labelAt(0);
  const everyNPoints = Math.max(1, Math.ceil((sample.length + 2) / barWidth));

  const marked: number[] = [];
  for (let i = points - 1; i >= 0; i -= everyNPoints) {
    marked.unshift(i);
  }

  let labels = " ".repeat(gutter + 2);
  for (const i of marked) {
    const startCol = gutter + 2 + i * barWidth;
    // 与前一个标签会挤在一起就跳过（+1 保证至少留一个空格）
    if (startCol < labels.length + 1) {
      continue;
    }
    labels = labels.padEnd(startCol) + labelAt(i);
  }
  return labels;
}

/**
 * 画纵向柱状图：Y 轴带刻度，横轴一列一个时间点。
 *
 * 相比单行 sparkline 的改进：有 Y 轴刻度可读出量级，8 行高度能看出峰谷形状。
 * 仍用线性刻度——试过对数刻度，虽让低谷可见，但整图几乎填满、峰值形状反而糊了。
 *
 * null 表示该时点无数据（与 0 不同），渲染为空列而非零高柱，避免把"没采到"
 * 显示成"用量为零"。
 */
export function verticalChart(
  values: Array<number | null>,
  labelAt: (index: number) => string,
  formatValue: (value: number) => string,
): ChartLines {
  const present = values.filter((v): v is number => typeof v === "number");
  const peak = present.length ? Math.max(...present) : 0;

  // 每个数据点画多列：24 个点若只占 24 列，X 轴上放不下几个时间标签，
  // 且柱子太细看不出形状。按点数自适应，总宽控制在 ~72 列（窄终端也不折行）。
  const barWidth = values.length <= 26 ? 3 : values.length <= 40 ? 2 : 1;
  // 柱子占满自己的列宽，不留间隔——留白反而让一根柱子看起来像断成两截，
  // 相邻时间点靠 X 轴刻度区分就够了
  const solid = barWidth;
  const width = values.length * barWidth;

  const grid: string[][] = Array.from({ length: CHART_HEIGHT }, () =>
    new Array<string>(width).fill(" "),
  );

  if (peak > 0) {
    values.forEach((value, index) => {
      if (typeof value !== "number") {
        return;
      }
      const scaled = (value / peak) * CHART_HEIGHT;
      const full = Math.floor(scaled);
      const frac = scaled - full;
      // 柱顶不足一格的部分用小块表示；太小的残差（<5%）不画，免得噪点
      const capLevel = frac > 0.05 ? EIGHTH_BLOCKS[Math.max(0, Math.round(frac * 8) - 1)] : undefined;
      for (let offset = 0; offset < solid; offset += 1) {
        const col = index * barWidth + offset;
        for (let r = 0; r < full && r < CHART_HEIGHT; r += 1) {
          grid[CHART_HEIGHT - 1 - r]![col] = "█";
        }
        if (full < CHART_HEIGHT && capLevel) {
          grid[CHART_HEIGHT - 1 - full]![col] = capLevel;
        }
      }
    });
  }

  // Y 轴刻度：每行标出该行顶端代表的值
  const gutter = 9;
  const rows = grid.map((line, r) => {
    const tick = peak * ((CHART_HEIGHT - r) / CHART_HEIGHT);
    return `${formatValue(tick).padStart(gutter)} ┤${line.join("")}`;
  });

  const axis = `${" ".repeat(gutter)} └${"─".repeat(width)}`;

  const labels = buildAxisLabels(values.length, barWidth, gutter, labelAt);

  return { rows, axis, labels };
}

/** 堆叠图的一个系列 */
export interface StackSeries {
  name: string;
  /** 各时间点的值，null/缺失按 0 处理 */
  values: Array<number | null>;
  /** 汇总值，用于图例排序与展示 */
  total: number;
  /** 是否是「其它 N 个」这类兜底分组，配色与标记都与具名系列区分 */
  isRest?: boolean;
}

/** 堆叠柱状图的高度。比单系列图高一些，否则占比小的系列会被挤成 0 格 */
const STACK_HEIGHT = 12;

/**
 * 画堆叠柱状图：一根柱子＝一个时间点，柱内自底向上按系列顺序分段着色。
 *
 * 相比「每系列一行 sparkline」的好处：既能看总量走势，又能看构成比例，
 * 且横轴只占一份宽度。对齐控制台「用量排行」页的呈现。
 *
 * 逐格判定归属（而非算每段的起止行）：格中心代表的量落在哪个系列的累积区间里，
 * 该格就归它。这样堆叠顺序天然保持自底向上，不会因为分段边界的取整而错乱
 * （先算边界再填的写法实测会让同一柱内颜色乱跳）。
 */
export function stackedChart(
  series: StackSeries[],
  labelAt: (index: number) => string,
  formatValue: (value: number) => string,
  glyphAt: (seriesIndex: number, isRest: boolean) => string,
  colorize: (seriesIndex: number, text: string, isRest: boolean) => string,
): ChartLines {
  const points = series[0]?.values.length ?? 0;
  const columnTotals = Array.from({ length: points }, (_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const peak = Math.max(0, ...columnTotals);

  // 26 而非 24：查 24 小时常返回 25 个点（含跨日边界那个），差一个就掉到 2 列宽，
  // 图会明显变窄且与相邻粒度的图不一致
  const barWidth = points <= 26 ? 3 : points <= 40 ? 2 : 1;
  const width = points * barWidth;
  const grid: Array<Array<number | null>> = Array.from({ length: STACK_HEIGHT }, () =>
    new Array<number | null>(width).fill(null),
  );

  if (peak > 0) {
    for (let ti = 0; ti < points; ti += 1) {
      const columnTotal = columnTotals[ti] ?? 0;
      if (columnTotal <= 0) {
        continue;
      }
      // 有量就至少画一格，否则占比极小的时间点会整根消失，看着像没用量
      const barHeight = Math.max(1, Math.round((columnTotal / peak) * STACK_HEIGHT));
      for (let r = 0; r < barHeight && r < STACK_HEIGHT; r += 1) {
        const cellValue = ((r + 0.5) / STACK_HEIGHT) * peak;
        let cumulative = 0;
        let owner = series.length - 1;
        for (let si = 0; si < series.length; si += 1) {
          cumulative += series[si]?.values[ti] ?? 0;
          if (cellValue <= cumulative) {
            owner = si;
            break;
          }
        }
        for (let b = 0; b < barWidth; b += 1) {
          grid[STACK_HEIGHT - 1 - r]![ti * barWidth + b] = owner;
        }
      }
    }
  }

  const gutter = 9;
  const rows = grid.map((line, r) => {
    const tick = peak * ((STACK_HEIGHT - r) / STACK_HEIGHT);
    let painted = "";
    for (const cell of line) {
      if (cell === null) {
        painted += " ";
        continue;
      }
      const isRest = series[cell]?.isRest === true;
      painted += colorize(cell, glyphAt(cell, isRest), isRest);
    }
    return `${formatValue(tick).padStart(gutter)} ┤${painted}`;
  });

  const axis = `${" ".repeat(gutter)} └${"─".repeat(width)}`;
  const labels = buildAxisLabels(points, barWidth, gutter, labelAt);

  return { rows, axis, labels };
}

/**
 * 打印「标签 : 值」两列，标签列按最长标签的显示宽度对齐。
 *
 * 不能硬编码空格数——中英文标签长度不同，写死了换语言就错位
 * （原先 auth status / endpoint get / key get 各自硬编码，英文界面全歪）。
 */
export function printAligned(rows: Array<[string, string]>): void {
  const width = Math.max(0, ...rows.map(([label]) => displayWidth(label)));
  for (const [label, value] of rows) {
    console.log(`${pad(label, width)} : ${value}`);
  }
}

/**
 * 打印表格，列宽按该列实际最长内容自适应。
 *
 * 起因是 ID 被截断的真 bug：`key list` 用 pad(id, 42) 打 44 字符的 ApiKeyId，
 * 尾部 3 位变成 "…"，用户把这一列复制去 `key get --id` 必然 ResourceNotFound。
 * EndpointId/ModelId 实测最长 37，却分别只给了 22/18，同样截断。
 *
 * ID 是要拿去复制粘贴的主键，宁可行宽超出终端换行，也不能截断——截断让整列失去
 * 用途。所以这里不接受固定宽度：调用方给数据，宽度由内容算出来。
 *
 * 最后一列不补空格，避免行尾拖一串没用的空白。
 */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] as number)))
      .join(" ")
      .trimEnd();
  console.log(line(headers));
  for (const row of rows) {
    console.log(line(row));
  }
}

/**
 * 端点停止原因 → 可操作的建议。文案在 locales（stopReason.*）。
 * 未收录的原因返回空串，调用方只打枚举值本身，不猜建议。
 *
 * 建议里的命令必须能照抄就用，所以要把 endpoint ID 填进去：原先文案写的是
 * `thcli endpoint postpaid on`，少了 `--endpoint <ID>`，用户照抄会得到
 * "unknown option --id" 之类的报错——给了错的指令比不给更糟。
 */
export function stopReasonAdvice(reason: string, endpointId?: string): string {
  const label = t(`stopReason.${reason}`, { id: endpointId ?? "<ID>" });
  return label.startsWith("stopReason.") ? "" : label;
}

/** 分页汇总行，各列表命令统一用它 */
export function summaryLine(total: unknown, returned: number, offset: unknown): string {
  return t("list.summary", { total: total ?? returned, returned, offset: offset ?? 0 });
}

/** sparkline 用的 8 级块字符，从低到高 */
const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** 零值占位符：空格（区分"无量"）或点（画出基线，让各行长度一致） */
const ZERO_MARKS = { blank: " ", baseline: "·" } as const;

/**
 * 把一串数值画成单行 sparkline。
 *
 * peak 显式传入，让多行 sparkline 能共用同一基准、纵向可比；不传则按本行最大值。
 * zeroMark 决定 0/null 怎么画：
 *   blank（默认）—— 空格，与"有量但很小"（至少 ▁）区分开
 *   baseline    —— 可见基线点，让多行等长、时间轴对得齐；尾部零值不会看起来"少一截"
 */
export function sparkline(
  values: Array<number | null>,
  peak?: number,
  zeroMark: keyof typeof ZERO_MARKS = "blank",
): string {
  const zero = ZERO_MARKS[zeroMark];
  const max = peak ?? Math.max(...values.map((v) => v ?? 0), 1);
  if (max <= 0) {
    return zero.repeat(values.length);
  }
  return values
    .map((v) => {
      if (!v || v <= 0) {
        return zero;
      }
      const level = Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * (SPARK_CHARS.length - 1)));
      // 有量就至少给一格，避免小值被画成空白而与"无量"混淆
      return SPARK_CHARS[Math.max(0, level)];
    })
    .join("");
}
