/**
 * 调用日志：管控面（console）与数据面（chat）分文件记录。
 *
 * 只记录 action/通道、trace_id/request_id、耗时、成败——**从不记录请求参数与
 * 响应体**，避免密钥明文（如 key reveal）落进本地日志。
 */
import fs from "node:fs";

import { LOG_DIR, logPath } from "./paths.js";

/** 单文件上限 5MB，超过则轮转一份 .1 备份 */
const MAX_BYTES = 5 * 1024 * 1024;

function append(file: string, line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // 文件不存在，首次写入
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // 日志写入失败不能影响命令本身
  }
}

function format(fields: Record<string, unknown>): string {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return `${new Date().toISOString()} | ${body}\n`;
}

/** 记一次管控面调用。request_id 是云 API 真实返回的，用于事后定位问题 */
export function logControlPlaneCall(
  profile: string,
  site: string,
  fields: {
    action: string;
    requestId?: string;
    traceId?: string;
    durationMs: number;
    status: "ok" | "error";
    error?: string;
  },
): void {
  append(
    logPath(profile, site, "console"),
    format({
      action: fields.action,
      request_id: fields.requestId,
      trace_id: fields.traceId,
      duration_ms: fields.durationMs,
      status: fields.status,
      error: fields.error,
    }),
  );
}

/** 记一次数据面调用。request_id 必须是网关真实返回的，客户端不生成 */
export function logDataPlaneCall(
  profile: string,
  site: string,
  fields: {
    channel: string;
    requestId?: string;
    durationMs: number;
    status: "ok" | "error";
    error?: string;
    extra?: Record<string, unknown>;
  },
): void {
  append(
    logPath(profile, site, "chat"),
    format({
      channel: fields.channel,
      request_id: fields.requestId || "-",
      duration_ms: fields.durationMs,
      status: fields.status,
      error: fields.error,
      ...fields.extra,
    }),
  );
}
