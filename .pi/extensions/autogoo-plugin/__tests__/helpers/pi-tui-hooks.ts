/**
 * 测试辅助：把 `@earendil-works/pi-tui` 解析到测试替身。
 *
 * 必须在 import 任何 `commands/*`、`utils/*-panel` **之前**调用（它们是静态依赖
 * pi-tui 的模块）。所以调用方一律用 `await import()` 动态加载被测模块，
 * 而不是在文件顶部静态 import —— 否则模块图在钩子安装前就已经解析失败了。
 *
 * 为什么只替身 4 个面板依赖的符号：渲染断言全部打在 `tui-kit` / `observe-tabs`
 * 的纯函数上（那里没有 pi-tui），替身只负责让"装载"这件事成功，
 * 不参与任何"渲染是否正确"的判断，避免用替身证明替身。
 */
import { registerHooks } from "node:module";

const STUB_URL = new URL("../stubs/pi-tui-stub.mjs", import.meta.url).href;

export function installPiTuiStub(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-tui") {
        return { url: STUB_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
