/** 把 `@earendil-works/pi-tui` 解析到测试替身（仅测试进程内生效）。 */
const STUB = new URL("./pi-tui-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-tui") {
    return { url: STUB, shortCircuit: true };
  }
  return next(specifier, context);
}
