/**
 * 扩展日志 —— **绝不写终端**。
 *
 * pi 的 TUI 独占屏幕：任何 `console.log`/`console.error`/`process.stderr.write`
 * 都会直接插进渲染流，绕过 TUI 的宽度与光标计算，表现为**乱码 / 残影 / 界面错位**。
 *
 * 之前的 `process.stderr.write("[AutoGoo-Plugin] ✅ 扩展已加载 …")` 就是典型
 * 反例（注释还写着 "to avoid interfering with Pi's TUI rendering"，完全说反了）。
 *
 * 所以：所有诊断信息写文件，界面上只通过 `ctx.ui.notify()` 给用户看。
 * 写入失败一律吞掉 —— 日志不能反过来把主流程弄挂。
 */

import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 1024 * 1024; // 1MB，超出后截断重来

function logPath(): string {
  const home = process.env.HOME || "~";
  return join(home, ".auto-goo", "logs", "plugin.log");
}

function write(level: string, parts: unknown[]): void {
  try {
    const path = logPath();
    const dir = join(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) {
        truncateSync(path, 0);
      }
    } catch {
      /* 尺寸检查失败不阻塞写入 */
    }
    const text = parts
      .map((p) => {
        if (p instanceof Error) return `${p.name}: ${p.message}`;
        if (typeof p === "string") return p;
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })
      .join(" ");
    appendFileSync(path, `${new Date().toISOString()} [${level}] ${text}\n`, "utf-8");
  } catch {
    /* 日志失败绝不影响主流程，也绝不回退到终端输出 */
  }
}

/** 一般诊断信息（替代 console.log/info）。 */
export function logInfo(...parts: unknown[]): void {
  write("info", parts);
}

/** 可恢复的问题（替代 console.warn）。 */
export function logWarn(...parts: unknown[]): void {
  write("warn", parts);
}

/** 异常（替代 console.error）。 */
export function logError(...parts: unknown[]): void {
  write("error", parts);
}
