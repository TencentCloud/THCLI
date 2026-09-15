/**
 * 打开系统默认浏览器。Node 无内置等价物，按平台调各自的命令。
 */
import { spawn } from "node:child_process";

/** 尝试打开 url，返回是否成功拉起 */
export async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [url], {
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32",
      });
      child.on("error", () => resolve(false));
      child.unref();
      // 拉起后立刻返回；命令本身是否真的显示了页面无法从这里判断
      setTimeout(() => resolve(true), 100);
    } catch {
      resolve(false);
    }
  });
}
