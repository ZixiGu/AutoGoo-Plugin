/**
 * utils/chat.ts 跨 session 对话 — 单元测试（node:test + node:assert/strict）
 *
 * 覆盖：
 *   a) registerSession upsert（同 id 更新 lastSeen；alias 递增）
 *   b) isPaired：同 thread 自动配对 / 显式配对 / 未配对
 *   c) sendMessage + drainMailbox 写读删闭环
 *   d) resolveAlias：精确匹配 / 前缀匹配 / 未找到
 *   e) 无效 target 报错路径（sendMessage 未配对时抛错）
 *   f) 通知 + 按需拉取：countUnread / peekMailbox 只读不删 / drainMailbox 删后清零 / putBackMessages 放回
 *
 * 运行：cd .pi/extensions/autogoo-plugin && node --experimental-strip-types --test __tests__/chat.test.ts
 * 或：  node --import tsx --test __tests__/chat.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSession,
  isPaired,
  addPair,
  removePair,
  sendMessage,
  drainMailbox,
  resolveAlias,
  setAlias,
  getUnreadCount,
  listSessions,
  getSession,
  peekMailbox,
  countUnread,
  putBackMessages,
} from "../utils/chat.ts";

// ── 测试夹具：临时目录 ──────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "goo-chat-test-"));
const cwd = join(root, "projA");
mkdirSync(join(cwd, ".goo"), { recursive: true });

const S1 = "11111111-aaaa-0000-0000-000000000001";
const S2 = "11111111-aaaa-0000-0000-000000000002";
const S3 = "22222222-bbbb-0000-0000-000000000003";

function setThread(threadId: string | null) {
  setThreadIn(cwd, threadId);
}

function setThreadIn(dir: string, threadId: string | null) {
  if (threadId) {
    writeFileSync(
      join(dir, ".goo", "current_thread.json"),
      JSON.stringify({ current_thread_id: threadId, thread_id: threadId }),
    );
  } else {
    try {
      rmSync(join(dir, ".goo", "current_thread.json"), { force: true });
    } catch {
      /* 测试夹具：文件本来就不存在时 rmSync 也可能报错，无需处理 */
    }
  }
}

// ── a) registerSession upsert ───────────────────────────────────────────────

test("registerSession 新增：alias 按项目序号递增", async () => {
  const s1 = await registerSession(cwd, S1, "/tmp/s1.jsonl");
  assert.equal(s1.alias, "projA@1");
  assert.equal(s1.project, "projA");
  assert.equal(s1.threadId, null);

  const s2 = await registerSession(cwd, S2, "/tmp/s2.jsonl");
  assert.equal(s2.alias, "projA@2");
});

test("registerSession upsert：同 id 更新 lastSeen，不新增", async () => {
  const before = await getSession(cwd, S1);
  assert.ok(before);

  await new Promise((r) => setTimeout(r, 20));
  const updated = await registerSession(cwd, S1, "/tmp/s1-new.jsonl");

  assert.equal(updated.alias, before!.alias, "alias 保持不变");
  assert.equal(updated.sessionFile, "/tmp/s1-new.jsonl", "sessionFile 更新");
  assert.ok(
    new Date(updated.lastSeen).getTime() >= new Date(before!.lastSeen).getTime(),
    "lastSeen 更新",
  );
  assert.equal((await listSessions(cwd)).length, 2, "不新增条目");
});

test("registerSession 读取 current_thread.json 得到 threadId", async () => {
  setThread("thread-x");
  const s = await registerSession(cwd, S3, "/tmp/s3.jsonl");
  assert.equal(s.threadId, "thread-x");
  setThread(null);
  const s2 = await registerSession(cwd, S3, "/tmp/s3.jsonl");
  assert.equal(s2.threadId, null);
});

// ── b) isPaired ─────────────────────────────────────────────────────────────

test("isPaired 同 threadId 自动配对", async () => {
  setThread("thread-auto");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  await registerSession(cwd, S2, "/tmp/s2.jsonl");
  assert.equal(await isPaired(cwd, S1, S2), true);
  assert.equal(await isPaired(cwd, S2, S1), true);
});

test("isPaired 不同 threadId 未配对（无显式配对时）", async () => {
  setThread("thread-a");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  setThread("thread-b");
  await registerSession(cwd, S2, "/tmp/s2.jsonl");
  assert.equal(await isPaired(cwd, S1, S2), false);
  setThread(null);
});

test("isPaired 显式配对命中（任意方向）", async () => {
  setThread("thread-a");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  setThread("thread-b");
  await registerSession(cwd, S2, "/tmp/s2.jsonl");
  await addPair(cwd, S1, S2);
  assert.equal(await isPaired(cwd, S1, S2), true);
  assert.equal(await isPaired(cwd, S2, S1), true, "任意方向命中");

  await removePair(cwd, S1, S2);
  assert.equal(await isPaired(cwd, S1, S2), false, "解除后不再配对");
  setThread(null);
});

test("isPaired 自己与自己不配对", async () => {
  assert.equal(await isPaired(cwd, S1, S1), false);
});

// ── c) sendMessage + drainMailbox 闭环 ─────────────────────────────────────

test("sendMessage + drainMailbox 写读删闭环", async () => {
  setThread("thread-msg");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  await registerSession(cwd, S2, "/tmp/s2.jsonl");

  const msg = await sendMessage(cwd, S1, S2, "你好，这是测试消息");
  assert.equal(msg.to, S2);
  assert.equal(msg.fromAlias, "projA@1");
  assert.equal(msg.content, "你好，这是测试消息");
  assert.equal(await getUnreadCount(cwd, S2), 1);

  const drained = await drainMailbox(cwd, S2);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].content, "你好，这是测试消息");
  assert.equal(drained[0].from, S1);
  assert.equal(await getUnreadCount(cwd, S2), 0, "读后删除");
  assert.deepEqual(await drainMailbox(cwd, S2), [], "重复 drain 为空");
  setThread(null);
});

test("sendMessage 未配对时抛错", async () => {
  setThread("thread-m1");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  setThread("thread-m2");
  await registerSession(cwd, S2, "/tmp/s2.jsonl");
  await assert.rejects(
    () => sendMessage(cwd, S1, S2, "不应投递"),
    /未配对/,
  );
  assert.equal(await getUnreadCount(cwd, S2), 0, "未配对不写信箱");
  setThread(null);
});

test("sendMessage 目标 session 未注册时抛错", async () => {
  setThread("thread-m1");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  await addPair(cwd, S1, "99999999-9999-0000-0000-000000000099");
  await assert.rejects(
    () => sendMessage(cwd, S1, "99999999-9999-0000-0000-000000000099", "x"),
    /不存在/,
  );
  setThread(null);
});

test("sendMessage 空内容抛错", async () => {
  setThread("thread-m1");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  await assert.rejects(() => sendMessage(cwd, S1, S2, "   "), /不能为空/);
  setThread(null);
});

// ── c2) peekMailbox / countUnread / putBackMessages（通知 + 按需拉取） ───────

test("countUnread 正确计数且只读不删", async () => {
  const rcwd = join(root, "projC1");
  mkdirSync(join(rcwd, ".goo"), { recursive: true });
  setThreadIn(rcwd, "thread-c1");
  await registerSession(rcwd, S1, "/tmp/s1.jsonl");
  await registerSession(rcwd, S2, "/tmp/s2.jsonl");

  assert.equal(await countUnread(rcwd, S2), 0, "初始无未读");
  await sendMessage(rcwd, S1, S2, "消息一");
  await sendMessage(rcwd, S1, S2, "消息二");
  assert.equal(await countUnread(rcwd, S2), 2);
  assert.equal(await getUnreadCount(rcwd, S2), 2, "getUnreadCount 与 countUnread 等价");
  setThreadIn(rcwd, null);
});

test("peekMailbox 只读不删：peek 后未读数不变且可重复 peek", async () => {
  const rcwd = join(root, "projC2");
  mkdirSync(join(rcwd, ".goo"), { recursive: true });
  setThreadIn(rcwd, "thread-c2");
  await registerSession(rcwd, S1, "/tmp/s1.jsonl");
  await registerSession(rcwd, S2, "/tmp/s2.jsonl");
  await sendMessage(rcwd, S1, S2, "第一条");
  await sendMessage(rcwd, S1, S2, "第二条");

  const peeked = await peekMailbox(rcwd, S2);
  assert.equal(peeked.length, 2);
  assert.equal(peeked[0].content, "第一条", "按时间升序");
  assert.equal(peeked[1].content, "第二条");
  assert.equal(await countUnread(rcwd, S2), 2, "peek 后未读数不变");

  // 重复 peek 幂等
  assert.equal((await peekMailbox(rcwd, S2)).length, 2);
  assert.equal(await countUnread(rcwd, S2), 2);
  setThreadIn(rcwd, null);
});

test("drainMailbox 删后 countUnread=0", async () => {
  const rcwd = join(root, "projC3");
  mkdirSync(join(rcwd, ".goo"), { recursive: true });
  setThreadIn(rcwd, "thread-c3");
  await registerSession(rcwd, S1, "/tmp/s1.jsonl");
  await registerSession(rcwd, S2, "/tmp/s2.jsonl");
  await sendMessage(rcwd, S1, S2, "A");
  await sendMessage(rcwd, S1, S2, "B");
  assert.equal(await countUnread(rcwd, S2), 2);

  const drained = await drainMailbox(rcwd, S2);
  assert.equal(drained.length, 2);
  assert.equal(await countUnread(rcwd, S2), 0, "读后即删");
  assert.deepEqual(await peekMailbox(rcwd, S2), [], "peek 同样为空");
  setThreadIn(rcwd, null);
});

test("putBackMessages 放回后未读数恢复（goo-chat-read 部分拉取语义）", async () => {
  const rcwd = join(root, "projC4");
  mkdirSync(join(rcwd, ".goo"), { recursive: true });
  setThreadIn(rcwd, "thread-c4");
  await registerSession(rcwd, S1, "/tmp/s1.jsonl");
  await registerSession(rcwd, S2, "/tmp/s2.jsonl");
  await sendMessage(rcwd, S1, S2, "保留的");

  // drain 后 countUnread=0，放回后恢复 1，且内容可再次 peek 到
  const drained = await drainMailbox(rcwd, S2);
  assert.equal(drained.length, 1);
  assert.equal(await countUnread(rcwd, S2), 0);
  await putBackMessages(rcwd, S2, drained);
  assert.equal(await countUnread(rcwd, S2), 1);
  const rePeeked = await peekMailbox(rcwd, S2);
  assert.equal(rePeeked.length, 1);
  assert.equal(rePeeked[0].content, "保留的");
  assert.equal(rePeeked[0].from, S1);
  assert.equal(rePeeked[0].fromAlias, "projC4@1", "原消息元数据保留");
  setThreadIn(rcwd, null);
});

// ── d) resolveAlias ─────────────────────────────────────────────────────────

test("resolveAlias 精确匹配 alias", async () => {
  const r = await resolveAlias(cwd, "projA@1");
  assert.ok(r);
  assert.equal(r!.sessionId, S1);
});

test("resolveAlias sessionId 前缀匹配（至少 8 字符）", async () => {
  // 用独立 cwd 隔离状态，避免与其他测试的注册表互相影响
  const rcwd = join(root, "projR");
  mkdirSync(join(rcwd, ".goo"), { recursive: true });
  await registerSession(rcwd, S1, "/tmp/s1.jsonl");
  await registerSession(rcwd, S2, "/tmp/s2.jsonl");
  await registerSession(rcwd, S3, "/tmp/s3.jsonl");

  // S3 首 8 字符前缀唯一 → 命中
  const r = await resolveAlias(rcwd, S3.slice(0, 8));
  assert.ok(r);
  assert.equal(r!.sessionId, S3);

  // 完整 sessionId 也走前缀匹配 → 命中
  const rFull = await resolveAlias(rcwd, S1);
  assert.equal(rFull!.sessionId, S1);

  // S1/S2 共享前缀 → 歧义返回 null（不猜测）
  assert.equal(await resolveAlias(rcwd, S1.slice(0, 8)), null);

  // 过短前缀（< 8 字符）不匹配
  assert.equal(await resolveAlias(rcwd, S3.slice(0, 4)), null);
});

test("resolveAlias 未找到返回 null", async () => {
  assert.equal(await resolveAlias(cwd, "projA@99"), null);
  assert.equal(await resolveAlias(cwd, "不存在的别名"), null);
});

// ── e) setAlias 冲突路径 ───────────────────────────────────────────────────

test("setAlias 成功 + 冲突拒绝", async () => {
  setThread("thread-alias");
  await registerSession(cwd, S1, "/tmp/s1.jsonl");
  await registerSession(cwd, S2, "/tmp/s2.jsonl");

  const ok = await setAlias(cwd, S2, "我的会话");
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.entry.alias, "我的会话");
  assert.equal((await resolveAlias(cwd, "我的会话"))!.sessionId, S2);

  const conflict = await setAlias(cwd, S1, "我的会话");
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok === false && conflict.reason, "alias_conflict");

  const notFound = await setAlias(cwd, "ffffffff-ffff-0000-0000-0000000000ff", "x");
  assert.equal(notFound.ok === false && notFound.reason, "session_not_found");
  setThread(null);
});

// ── 清理 ────────────────────────────────────────────────────────────────────

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
