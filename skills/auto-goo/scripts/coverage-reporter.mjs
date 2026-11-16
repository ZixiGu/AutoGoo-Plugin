/**
 * node:test 覆盖率 reporter —— 把结构化覆盖率数据落成 JSON。
 *
 * 为什么要它：`--experimental-test-coverage` 的默认输出是**人读的表格**，
 * 而且只列出「被加载过」的文件。解析那种表格既脆弱（目录层级用缩进表达、
 * 同名文件靠上下文区分）又失真（没加载的文件直接缺席，看起来像 100%）。
 *
 * node 的 reporter API 会在 `test:coverage` 事件里给出结构化 summary：
 *   { files: [{ path, totalLineCount, coveredLineCount, ... }], totals: {...} }
 * 这里原样落盘，由 `coverage-report.py` 负责把它和「源文件全集」做差集，
 * 把从未被加载的文件按 0% 计入分母。
 *
 * 用法（由 coverage-report.py 调用，不单独使用）：
 *   AUTOGOO_COVERAGE_JSON=/tmp/cov.json \
 *     tsx --test --experimental-test-coverage \
 *         --test-reporter=spec  --test-reporter-destination=stdout \
 *         --test-reporter=./coverage-reporter.mjs --test-reporter-destination=/dev/null \
 *         __tests__/*.test.ts
 */

import { writeFileSync } from "node:fs";

export default async function* coverageReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:coverage") continue;
    const out = process.env.AUTOGOO_COVERAGE_JSON;
    if (!out) continue;
    try {
      writeFileSync(out, JSON.stringify(event.data.summary, null, 2), "utf-8");
    } catch (e) {
      // 写不出来就让上层脚本报错退出，不要在这里吞掉
      process.stderr.write(`coverage-reporter: 无法写入 ${out}: ${e}\n`);
      process.exitCode = 1;
    }
  }
}
