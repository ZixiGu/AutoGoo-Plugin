/**
 * AutoGoo-Plugin 跨 session 对话 — 会话注册、配对、文件信箱
 *
 * A+C 混合方案：同 thread 自动配对 + /goo-pair 显式配对，
 * 消息通过 `.goo/chat/mailbox/` 下信箱文件异步投递。
 *
 * 数据位置（均在项目 `.goo/chat/` 下）：
 *   - sessions.json 注册表：[{sessionId, sessionFile, project, threadId, alias, lastSeen}]
 *   - pairs.json     显式配对表：[[fromSessionId, toSessionId], ...]
 *   - mailbox/<toSessionId>/<ts>_<fromSessionId>.json  待投递消息
 *
 * 所有读写用 node:fs/promises；JSON 原子写（tmp+rename，参考 utils/plan.ts savePlan）；
 * 损坏 JSON 容错（跳过该文件/条目）。
 */

import { readFile, writeFile, mkdir, readdir, rename, access, unlink } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { getCurrentThreadId } from "./plan.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChatSessionEntry {
  sessionId: string;
  sessionFile: string | null;
  /** cwd 的 basename */
  project: string;
  threadId: string | null;
  /** 别名 `<project>@<序号>`，可用 /goo-alias 自定义 */
  alias: string;
  lastSeen: string;
}

export interface ChatPair {
  from: string;
  to: string;
  pairedAt: string;
}

export interface ChatMessage {
  from: string;
  fromAlias?: string;
  fromProject?: string;
  to: string;
  content: string;
  ts: string;
  threadId: string | null;
}

export type SetAliasResult =
  | { ok: true; entry: ChatSessionEntry }
  | { ok: false; reason: "session_not_found" | "alias_conflict" };

// ── Paths ───────────────────────────────────────────────────────────────────

function sessionsRegistryPath(cwd: string): string {
  return join(cwd, ".goo/chat/sessions.json");
}

function pairsPath(cwd: string): string {
  return join(cwd, ".goo/chat/pairs.json");
}

function sessionMailboxDir(cwd: string, sessionId: string): string {
  return join(cwd, ".goo/chat/mailbox", sessionId);
}

// ── 底层读写 ────────────────────────────────────────────────────────────────

/** JSON 原子写：先写 .tmp 再 rename（与 utils/plan.ts savePlan 一致）。 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmp, filePath);
}

/** 读 JSON 数组；文件缺失或损坏 JSON 均容错返回 []。 */
async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    await access(filePath);
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return [];
  }
}

function sanitizeTs(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

// ── 注册表 ───────────────────────────────────────────────────────────────────

/**
 * 生成别名 `<project>@<序号>`：同项目已有 session 数量 + 1。
 * （注册表按项目隔离，同 cwd 下 project 一致。）
 */
function generateAlias(entries: ChatSessionEntry[], project: string): string {
  const sameProject = entries.filter((e) => e.project === project);
  return `${project}@${sameProject.length + 1}`;
}

/**
 * 注册（upsert）会话：同 sessionId 更新 lastSeen / sessionFile / threadId，
 * 新会话按 `<project>@<序号>` 生成 alias。
 * threadId 从 `.goo/current_thread.json` 读取，读取失败为 null。
 */
export async function registerSession(
  cwd: string,
  sessionId: string,
  sessionFile: string | null,
): Promise<ChatSessionEntry> {
  const entries = await readJsonArray<ChatSessionEntry>(sessionsRegistryPath(cwd));
  const project = basename(cwd);
  const now = new Date().toISOString();

  let threadId: string | null = null;
  try {
    threadId = await getCurrentThreadId(cwd);
  } catch {
    threadId = null;
  }

  const existing = entries.find((e) => e.sessionId === sessionId);
  if (existing) {
    existing.lastSeen = now;
    if (sessionFile) existing.sessionFile = sessionFile;
    existing.threadId = threadId;
    if (!existing.project) existing.project = project;
  } else {
    entries.push({
      sessionId,
      sessionFile,
      project,
      threadId,
      alias: generateAlias(entries, project),
      lastSeen: now,
    });
  }

  await atomicWriteJson(sessionsRegistryPath(cwd), entries);
  return entries.find((e) => e.sessionId === sessionId)!;
}

/** 列出注册表全部会话。 */
export async function listSessions(cwd: string): Promise<ChatSessionEntry[]> {
  return readJsonArray<ChatSessionEntry>(sessionsRegistryPath(cwd));
}

/** 按 sessionId 精确查找注册表条目。 */
export async function getSession(cwd: string, sessionId: string): Promise<ChatSessionEntry | null> {
  const entries = await listSessions(cwd);
  return entries.find((e) => e.sessionId === sessionId) ?? null;
}

/**
 * 别名解析：精确匹配 alias；否则 sessionId 前缀匹配（至少 8 字符且唯一）；否则 null。
 */
export async function resolveAlias(cwd: string, alias: string): Promise<ChatSessionEntry | null> {
  const trimmed = alias.trim();
  if (!trimmed) return null;
  const entries = await listSessions(cwd);

  const exact = entries.find((e) => e.alias === trimmed);
  if (exact) return exact;

  if (trimmed.length >= 8) {
    const prefixMatches = entries.filter((e) => e.sessionId.startsWith(trimmed));
    if (prefixMatches.length === 1) return prefixMatches[0];
    // 多会话同前缀：不猜测，返回 null（由命令提示精确 alias）
  }
  return null;
}

/** 自定义本会话别名；alias 已被其他 session 占用时返回 alias_conflict。 */
export async function setAlias(cwd: string, sessionId: string, alias: string): Promise<SetAliasResult> {
  const trimmed = alias.trim();
  const entries = await listSessions(cwd);
  const entry = entries.find((e) => e.sessionId === sessionId);
  if (!entry) return { ok: false, reason: "session_not_found" };
  const conflict = entries.find((e) => e.sessionId !== sessionId && e.alias === trimmed);
  if (conflict) return { ok: false, reason: "alias_conflict" };
  entry.alias = trimmed;
  await atomicWriteJson(sessionsRegistryPath(cwd), entries);
  return { ok: true, entry };
}

// ── 配对 ─────────────────────────────────────────────────────────────────────

/**
 * 判断两个 session 是否配对：
 *   1. 同 threadId（且均非 null）→ 自动配对
 *   2. 显式配对表命中（任意方向）
 */
export async function isPaired(cwd: string, fromId: string, toId: string): Promise<boolean> {
  if (fromId === toId) return false;

  const entries = await listSessions(cwd);
  const from = entries.find((e) => e.sessionId === fromId);
  const to = entries.find((e) => e.sessionId === toId);
  if (from && to && from.threadId && to.threadId && from.threadId === to.threadId) {
    return true;
  }

  const pairs = await readJsonArray<ChatPair>(pairsPath(cwd));
  return pairs.some(
    (p) => (p.from === fromId && p.to === toId) || (p.from === toId && p.to === fromId),
  );
}

/** 写入显式配对（幂等：已存在则不重复）。 */
export async function addPair(cwd: string, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) throw new Error("不能配对同一个 session");
  const pairs = await readJsonArray<ChatPair>(pairsPath(cwd));
  const exists = pairs.some(
    (p) => (p.from === fromId && p.to === toId) || (p.from === toId && p.to === fromId),
  );
  if (!exists) {
    pairs.push({ from: fromId, to: toId, pairedAt: new Date().toISOString() });
    await atomicWriteJson(pairsPath(cwd), pairs);
  }
}

/** 删除显式配对；存在并删除返回 true，不存在返回 false。 */
export async function removePair(cwd: string, fromId: string, toId: string): Promise<boolean> {
  const pairs = await readJsonArray<ChatPair>(pairsPath(cwd));
  const before = pairs.length;
  const filtered = pairs.filter(
    (p) => !((p.from === fromId && p.to === toId) || (p.from === toId && p.to === fromId)),
  );
  if (filtered.length !== before) {
    await atomicWriteJson(pairsPath(cwd), filtered);
    return true;
  }
  return false;
}

/** 列出显式配对表。 */
export async function listPairs(cwd: string): Promise<ChatPair[]> {
  return readJsonArray<ChatPair>(pairsPath(cwd));
}

// ── 消息信箱 ─────────────────────────────────────────────────────────────────

/**
 * 发送消息：校验 isPaired → 写入收件方信箱文件。
 * 未配对抛错；目标 session 未注册抛错。
 */
export async function sendMessage(
  cwd: string,
  fromId: string,
  toId: string,
  content: string,
): Promise<ChatMessage> {
  if (!content || !content.trim()) throw new Error("消息内容不能为空");

  const paired = await isPaired(cwd, fromId, toId);
  if (!paired) {
    throw new Error(`未配对: ${fromId} → ${toId}，用 /goo-pair 配对 或 同 thread 自动配对`);
  }

  const entries = await listSessions(cwd);
  const toEntry = entries.find((e) => e.sessionId === toId);
  if (!toEntry) throw new Error(`目标 session 不存在: ${toId}`);
  const fromEntry = entries.find((e) => e.sessionId === fromId);

  const msg: ChatMessage = {
    from: fromId,
    fromAlias: fromEntry?.alias,
    fromProject: fromEntry?.project,
    to: toId,
    content,
    ts: new Date().toISOString(),
    threadId: fromEntry?.threadId ?? null,
  };

  const dir = sessionMailboxDir(cwd, toId);
  await mkdir(dir, { recursive: true });
  // 文件名 `<ts>_<fromId>.json`；同毫秒连续发送会重名，追加序号避免覆盖（保证不丢消息）
  let file = `${sanitizeTs(msg.ts)}_${fromId}.json`;
  let i = 1;
  const existing = new Set<string>();
  try {
    for (const f of await readdir(dir)) existing.add(f);
  } catch {}
  while (existing.has(file)) {
    file = `${sanitizeTs(msg.ts)}_${fromId}_${i}.json`;
    i++;
  }
  await writeFile(join(dir, file), JSON.stringify(msg, null, 2) + "\n", "utf-8");
  return msg;
}

/** 读取信箱内全部未损坏消息（只读，不删文件）。损坏 JSON 跳过。 */
async function readMailboxMessages(cwd: string, sessionId: string): Promise<ChatMessage[]> {
  const dir = sessionMailboxDir(cwd, sessionId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    try {
      const raw = await readFile(join(dir, f), "utf-8");
      const msg = JSON.parse(raw) as ChatMessage;
      if (msg && typeof msg.content === "string") messages.push(msg);
    } catch {
      // 损坏 JSON：跳过内容（drainMailbox 中仍会删除该文件）
    }
  }
  return messages;
}

/**
 * 只读查看未读消息（不删除，供通知/列表用）。按文件名（时间戳）升序返回。
 */
export async function peekMailbox(cwd: string, sessionId: string): Promise<ChatMessage[]> {
  return readMailboxMessages(cwd, sessionId);
}

/** 未读消息数（只读不删，供 session_start 通知用）。 */
export async function countUnread(cwd: string, sessionId: string): Promise<number> {
  const dir = sessionMailboxDir(cwd, sessionId);
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * 收信：列出并读取 mailbox/<sessionId>/ 下全部消息，读后删除，返回消息数组。
 * 损坏消息跳过但同样删除（不阻塞后续投递）。供 /goo-chat-read 拉取。
 */
export async function drainMailbox(cwd: string, sessionId: string): Promise<ChatMessage[]> {
  const dir = sessionMailboxDir(cwd, sessionId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    const p = join(dir, f);
    try {
      const raw = await readFile(p, "utf-8");
      const msg = JSON.parse(raw) as ChatMessage;
      if (msg && typeof msg.content === "string") messages.push(msg);
    } catch {
      // 损坏 JSON：跳过内容，仍删除文件
    }
    await unlink(p).catch(() => {});
  }
  return messages;
}

/**
 * 把消息写回信箱（/goo-chat-read 带 target 只拉取部分消息时，未注入的放回）。
 * 保持原消息 JSON 结构与文件名约定 `<ts>_<fromId>.json`；重名时追加序号避免覆盖。
 */
export async function putBackMessages(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const dir = sessionMailboxDir(cwd, sessionId);
  await mkdir(dir, { recursive: true });
  const existing = new Set<string>();
  try {
    for (const f of await readdir(dir)) existing.add(f);
  } catch {}
  for (const msg of messages) {
    let file = `${sanitizeTs(msg.ts)}_${msg.from}.json`;
    let i = 1;
    while (existing.has(file)) {
      file = `${sanitizeTs(msg.ts)}_${msg.from}_${i}.json`;
      i++;
    }
    existing.add(file);
    await writeFile(join(dir, file), JSON.stringify(msg, null, 2) + "\n", "utf-8");
  }
}

/** 统计某 session 未读消息数（信箱内 .json 文件数）。兼容别名，等价 countUnread。 */
export async function getUnreadCount(cwd: string, sessionId: string): Promise<number> {
  return countUnread(cwd, sessionId);
}
