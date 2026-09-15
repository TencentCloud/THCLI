/**
 * skills 分发源 URL 的解析。三层覆盖，从高到低：
 *
 *   1) 环境变量 THCLI_SKILLS_URL —— 完整 latest.json URL，用于 CI/测试临时覆盖
 *   2) settings.env 路由到内置默认表 —— 正常运行时的路径
 *   3) prod 兜底 —— settings.env 为空或未知值时回落
 *
 * skills 不随 npm 包分发（0.2.0 起），CLI 首次使用需 `thcli +connect`
 * 从这里指向的 COS 拉一次，写入 ~/.thcli/skills-cache/。
 */
import { getSetting } from "./settings.js";

/** 解析后的分发源，只保留 latest.json URL——真实的 baseUrl 由 latest.json 内部字段给出，
 *  这样发新版本时改远端 latest.json 即可切换，CLI 不需要重新发布。 */
export interface SkillsSource {
  /** 拉 skills 元信息的入口。GET 该 URL 得到 { version, baseUrl, publishedAt, ... } */
  latestUrl: string;
  /** 便于错误提示：本次解析走的是哪个来源 */
  origin: "env" | "settings" | "default";
}

/**
 * 内置默认分发源。只有正式桶——与 config.ts 的 envs 同一个理由：这个文件会被
 * bundle 进 dist/main.cjs 随 npm 包公开，非正式环境的桶名不该编进产物。
 *
 * 要指向别的桶（联调用的测试桶、私有部署的镜像）走 THCLI_SKILLS_URL 环境变量，
 * 它的优先级最高，见下方 resolveSkillsSource。
 */
const DEFAULT_SKILLS_URLS: Record<string, string> = {
  prod: "https://gz-thcli-skills-1258344699.cos.ap-guangzhou.myqcloud.com/tokenhub-cli-skills/latest.json",
};

/** 环境变量名——测试/CI 场景可临时覆盖 */
export const SKILLS_URL_ENV = "THCLI_SKILLS_URL";

/**
 * 解析当前应使用的 skills 分发源。
 * 优先级：环境变量 > settings.env 路由 > prod 兜底
 */
export function resolveSkillsSource(): SkillsSource {
  const envUrl = process.env[SKILLS_URL_ENV];
  if (envUrl && envUrl.trim()) {
    return { latestUrl: envUrl.trim(), origin: "env" };
  }
  const env = (getSetting("env") || "prod").toLowerCase();
  const url = DEFAULT_SKILLS_URLS[env] ?? DEFAULT_SKILLS_URLS["prod"] ?? "";
  return {
    latestUrl: url,
    origin: env in DEFAULT_SKILLS_URLS ? "settings" : "default",
  };
}
