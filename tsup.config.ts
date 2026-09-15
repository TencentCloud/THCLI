import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

// 从 package.json 读版本号，编译期注入到 __VERSION__ 占位符。
// 这样源码里不用硬编码，npm version bump 后 build 会自动生效——避免 main.ts
// 与 package.json 双写漂移。
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// 把整个 CLI（含第三方依赖）bundle 成单个文件：
//  - 用户侧零运行时依赖，npm 包只有极少文件、体积小、安装快
//  - minify 去注释/压缩变量名，源码逻辑不再逐文件裸露（对齐外网官方 CLI 的分发形态）
//
// 产物格式用 CJS 而非 ESM：腾讯云 SDK 是 CommonJS，内部用 require() 加载 Node 内置
// 模块；bundle 进 ESM 会触发 esbuild 的 "Dynamic require is not supported"。CLI 作为
// bin 用 CJS 运行没有任何问题，且 require 原生支持这些依赖。
// shims 开启后，源码里的 import.meta.url 会被转换为 CJS 可用的等价物。
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  bundle: true,
  minify: true,
  sourcemap: false,
  clean: true,
  dts: false,
  splitting: false,
  shims: true,
  noExternal: [/.*/],
  define: {
    // 全局字符串常量替换：__VERSION__ → "0.2.0"（含引号，故用 JSON.stringify）
    __VERSION__: JSON.stringify(pkg.version),
  },
});
