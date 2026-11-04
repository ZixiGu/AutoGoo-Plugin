/**
 * 把 pi 的 toolCall 压成一行可读摘要，用于派发进度显示。
 *
 * 之前进度行里工具调用被硬编码成 `⟦bash(...⟧` —— **参数全丢**，用户只看到
 * 「有个 bash 在跑」，看不到"跑的是什么"。实际上 ToolCall 的 arguments 是
 * 完整的（`{ type:"toolCall", name, arguments: JsonObject }`），只是没被用。
 */

const MAX_DETAIL = 110;

function pickString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function firstStringArg(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function clip(text: string, limit = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * 生成形如 `bash: ls -la /tmp`、`read: src/index.ts`、`grep: TODO in src/` 的摘要。
 * 未知工具退化为「第一个字符串参数」，再退化到 JSON 片段。
 */
function describeToolCall(part: any): string {
  const name = String(part?.name ?? "tool");
  let args: Record<string, unknown> = {};
  const raw = part?.arguments;
  if (raw && typeof raw === "object") {
    args = raw as Record<string, unknown>;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      return `${name}: ${clip(raw)}`;
    }
  }

  let detail = "";
  switch (name) {
    case "bash":
    case "shell":
      detail = pickString(args, ["command", "cmd", "script"]);
      break;
    case "read":
    case "write":
    case "edit":
    case "view":
    case "ls":
      detail = pickString(args, ["path", "file_path", "filePath", "file", "filePathOrDir"]);
      break;
    case "grep":
    case "search":
    case "glob":
    case "find":
      detail = [pickString(args, ["pattern", "query", "glob"]), pickString(args, ["path", "dir"])]
        .filter(Boolean)
        .join(" in ");
      break;
    case "auto_goo_ssh_exec":
    case "auto_goo_ssh_status":
    case "auto_goo_ssh_monitor":
      detail = [pickString(args, ["server"]), pickString(args, ["command"])].filter(Boolean).join(": ");
      break;
    case "auto_goo_update_step":
      detail = [
        pickString(args, ["stepId"]),
        pickString(args, ["action"]),
        pickString(args, ["note"]),
      ]
        .filter(Boolean)
        .join(" ");
      break;
    case "auto_goo_dispatch":
      detail = [pickString(args, ["stepId"]), pickString(args, ["role"])].filter(Boolean).join(" ");
      break;
    default:
      detail = firstStringArg(args);
      if (!detail) {
        try {
          detail = JSON.stringify(args);
        } catch {
          detail = "";
        }
        if (detail === "{}") detail = "";
      }
  }

  const clipped = clip(detail);
  return clipped ? `${name}: ${clipped}` : name;
}

/** 把一批 content part 渲染成若干可读行（text 原样，toolCall 走摘要）。 */
export function describeMessageContent(content: unknown, maxTextLength = 300): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? clip(content, maxTextLength) : "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const anyPart = part as any;
    if (anyPart.type === "text" && typeof anyPart.text === "string" && anyPart.text.trim()) {
      parts.push(clip(anyPart.text, maxTextLength));
    } else if (anyPart.type === "toolCall") {
      parts.push(`⟦${describeToolCall(anyPart)}⟧`);
    }
  }
  return parts.join("  ");
}

/** 工具结果压成单行摘要（取首行 + 截断）。 */
export function describeToolResult(message: any, limit = 160): string {
  const content = message?.content;
  let text = "";
  if (Array.isArray(content)) {
    text = content
      .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .join(" ");
  } else if (typeof content === "string") {
    text = content;
  }
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  return clip(firstLine, limit);
}
