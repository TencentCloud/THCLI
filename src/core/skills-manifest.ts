/**
 * Skills manifest 的加载、比对、下载。
 *
 * 分发链路（A 方案：版本目录 + latest.json 原子切换）：
 *
 *   远端 COS:
 *     <prefix>/
 *     ├── latest.json          { "version": "1.0.0", "baseUrl": ".../v1.0.0/", "publishedAt": "..." }
 *     ├── v1.0.0/              版本目录，发布后不再改动
 *     │   ├── manifest.json    { version, publishedAt, skills: [...] }
 *     │   ├── thcli-shared/SKILL.md
 *     │   └── ...
 *     └── v0.9.0/              上一版仍保留，供回滚
 *
 *   本地缓存：
 *     ~/.thcli/skills-cache/
 *     ├── manifest.json        与远端该版本的 manifest.json 内容一致
 *     └── ...同结构...
 *
 * 为什么版本目录不可变很重要：本模块先取 manifest（含各文件 sha256）、再逐个下载
 * 文件校验。若远端在这中间被覆盖，sha256 必然对不上、整批回滚。版本目录保证
 * baseUrl 指向的内容在下载期间不会变，发布方切换 latest.json 也不影响进行中的下载。
 *
 * refresh 流程：
 *   1) GET latest.json                  → 拿 baseUrl
 *   2) GET baseUrl + "manifest.json"    → 拿文件清单
 *   3) 对每个文件：sha256 与本地一致则 skip，否则 GET 并校验，写临时文件
 *   4) 全部成功后原子替换本地 manifest.json；任意一步失败即回滚（临时文件清理）
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SKILLS_CACHE_DIR, SKILLS_MANIFEST_PATH } from "./paths.js";

/** 单个文件条目（相对 skill 目录） */
export interface FileEntry {
  path: string;
  sha256: string;
  size: number;
}

/** 单个 skill 的清单 */
export interface SkillEntry {
  name: string;
  files: FileEntry[];
}

/** 完整 manifest 结构，与远端版本目录下的 manifest.json 一一对应 */
export interface SkillManifest {
  version: string;
  publishedAt: string;
  skills: SkillEntry[];
}

/** latest.json 结构（放在 COS 根路径的入口索引） */
export interface LatestIndex {
  version: string;
  baseUrl: string;
  publishedAt?: string;
}

/** refresh 完成后返回的摘要 */
export interface RefreshResult {
  version: string;
  downloaded: number;
  skipped: number;
  removed: number;
  totalBytes: number;
}

/** 本地缓存是否与远端一致的比对结果 */
export interface DiffReport {
  added: string[];
  changed: string[];
  removed: string[];
}

/** 通用 fetch 封装：失败给可读原因，避免 undici 层堆栈干扰用户 */
async function fetchOrThrow(url: string, kind: "json" | "text" | "binary"): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    // DNS 失败 / 连接被拒 / 证书错误 等都走这里
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch failed: ${url} (${reason})`);
  }
  if (!resp.ok) {
    throw new Error(`fetch failed: ${url} → HTTP ${resp.status}`);
  }
  if (kind === "json") {
    return (await resp.json()) as unknown;
  }
  if (kind === "text") {
    return await resp.text();
  }
  return Buffer.from(await resp.arrayBuffer());
}

/** GET latest.json，取 baseUrl */
export async function fetchLatestIndex(latestUrl: string): Promise<LatestIndex> {
  const data = (await fetchOrThrow(latestUrl, "json")) as Partial<LatestIndex>;
  if (!data || typeof data.baseUrl !== "string" || typeof data.version !== "string") {
    throw new Error(`invalid latest.json: missing version/baseUrl (${latestUrl})`);
  }
  return {
    version: data.version,
    baseUrl: data.baseUrl.endsWith("/") ? data.baseUrl : `${data.baseUrl}/`,
    publishedAt: data.publishedAt,
  };
}

/** GET baseUrl + manifest.json，取版本内文件清单 */
export async function fetchRemoteManifest(baseUrl: string): Promise<SkillManifest> {
  const url = `${baseUrl}manifest.json`;
  const data = (await fetchOrThrow(url, "json")) as Partial<SkillManifest>;
  if (!data || !Array.isArray(data.skills) || typeof data.version !== "string") {
    throw new Error(`invalid manifest.json: missing skills/version (${url})`);
  }
  return {
    version: data.version,
    publishedAt: data.publishedAt || "",
    skills: data.skills as SkillEntry[],
  };
}

/** 读取本地缓存的 manifest；文件不存在或解析失败返回 null（首次 refresh） */
export function readLocalManifest(): SkillManifest | null {
  try {
    const raw = fs.readFileSync(SKILLS_MANIFEST_PATH, "utf8");
    const data = JSON.parse(raw) as Partial<SkillManifest>;
    if (!data || !Array.isArray(data.skills) || typeof data.version !== "string") {
      return null;
    }
    return data as SkillManifest;
  } catch {
    return null;
  }
}

/** 比对本地与远端 manifest，得出新增/修改/删除的 skill 列表（按 skill 名维度） */
export function diffManifest(local: SkillManifest | null, remote: SkillManifest): DiffReport {
  const localMap = new Map<string, SkillEntry>();
  const localHashOf = (skill: SkillEntry): string =>
    skill.files
      .map((f) => `${f.path}:${f.sha256}`)
      .sort()
      .join("|");
  if (local) {
    for (const s of local.skills) {
      localMap.set(s.name, s);
    }
  }
  const added: string[] = [];
  const changed: string[] = [];
  const remoteNames = new Set<string>();
  for (const s of remote.skills) {
    remoteNames.add(s.name);
    const prev = localMap.get(s.name);
    if (!prev) {
      added.push(s.name);
    } else if (localHashOf(prev) !== localHashOf(s)) {
      changed.push(s.name);
    }
  }
  const removed: string[] = [];
  for (const name of localMap.keys()) {
    if (!remoteNames.has(name)) {
      removed.push(name);
    }
  }
  return { added, changed, removed };
}

/** 计算 buffer 的 sha256 十六进制串 */
function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 读本地文件的 sha256；不存在或读失败返回 null */
function localFileSha256(fullPath: string): string | null {
  try {
    const buf = fs.readFileSync(fullPath);
    return sha256Hex(buf);
  } catch {
    return null;
  }
}

/**
 * 执行一次全量刷新。
 *
 * 幂等且可重入：每个文件先写 .tmp 再原子 rename，manifest.json 最后写入，
 * 中途失败时已写入的临时文件被清理，本地缓存保持"之前的状态"。
 */
export async function refreshSkills(opts: {
  latestUrl: string;
  onProgress?: (msg: string) => void;
}): Promise<RefreshResult> {
  const progress = opts.onProgress || ((): void => undefined);

  progress(`GET ${opts.latestUrl}`);
  const latest = await fetchLatestIndex(opts.latestUrl);

  progress(`GET ${latest.baseUrl}manifest.json`);
  const remote = await fetchRemoteManifest(latest.baseUrl);

  const local = readLocalManifest();

  fs.mkdirSync(SKILLS_CACHE_DIR, { recursive: true });

  // 需要下载的文件列表（sha256 不匹配的）
  interface DownloadTask {
    skill: string;
    entry: FileEntry;
  }
  const tasks: DownloadTask[] = [];
  let skipped = 0;
  for (const skill of remote.skills) {
    for (const entry of skill.files) {
      const localPath = path.join(SKILLS_CACHE_DIR, skill.name, entry.path);
      const localSha = localFileSha256(localPath);
      if (localSha === entry.sha256) {
        skipped++;
      } else {
        tasks.push({ skill: skill.name, entry });
      }
    }
  }

  // 临时文件跟踪，任何一步失败时清理
  const writtenTmp: string[] = [];
  let totalBytes = 0;
  try {
    for (const t of tasks) {
      const url = `${latest.baseUrl}${t.skill}/${t.entry.path}`;
      progress(`GET ${t.skill}/${t.entry.path}`);
      const buf = (await fetchOrThrow(url, "binary")) as Buffer;

      const gotSha = sha256Hex(buf);
      if (gotSha !== t.entry.sha256) {
        throw new Error(
          `sha256 mismatch: ${t.skill}/${t.entry.path} (expected ${t.entry.sha256}, got ${gotSha})`,
        );
      }
      const dst = path.join(SKILLS_CACHE_DIR, t.skill, t.entry.path);
      const tmp = `${dst}.tmp`;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(tmp, buf);
      writtenTmp.push(tmp);
      totalBytes += buf.length;
    }

    // 全部下载校验通过后，统一 rename 到正式路径
    for (const tmp of writtenTmp) {
      const dst = tmp.slice(0, -".tmp".length);
      fs.renameSync(tmp, dst);
    }
  } catch (err) {
    // 回滚：删除已写入的 .tmp
    for (const tmp of writtenTmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 忽略清理失败
      }
    }
    throw err;
  }

  // 删除远端已移除的 skill 目录
  let removed = 0;
  if (local) {
    const remoteNames = new Set(remote.skills.map((s) => s.name));
    for (const s of local.skills) {
      if (!remoteNames.has(s.name)) {
        try {
          fs.rmSync(path.join(SKILLS_CACHE_DIR, s.name), { recursive: true, force: true });
          removed++;
        } catch {
          // 忽略，manifest 更新后下次也会看到清理效果
        }
      }
    }
  }

  // 最后原子写入 manifest.json（写完这一步才算"刷新完成"）
  const manifestTmp = `${SKILLS_MANIFEST_PATH}.tmp`;
  fs.writeFileSync(manifestTmp, `${JSON.stringify(remote, null, 2)}\n`);
  fs.renameSync(manifestTmp, SKILLS_MANIFEST_PATH);

  return {
    version: remote.version,
    downloaded: tasks.length,
    skipped,
    removed,
    totalBytes,
  };
}
