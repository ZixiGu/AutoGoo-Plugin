/**
 * UI helpers — timeout-aware wrappers around Pi's ctx.ui dialogs.
 *
 * Pi's dialogs natively support `{ timeout }`; on expiry the dialog
 * auto-dismisses (with a live countdown) and resolves to:
 *   select -> undefined, input -> undefined, confirm -> false
 *
 * These helpers turn that into an explicit fallback so an unanswered prompt
 * never blocks the workflow:
 *   - select : adopt the option labelled "(Recommended)" when present, else cancel
 *   - confirm: fall back to `defaultOnTimeout` (defaults to false — never auto-confirm)
 *   - input  : fall back to `defaultValue`
 *
 * Non-interactive modes (json/print, `ctx.hasUI === false`) skip the dialog
 * entirely and resolve the fallback immediately.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectOption } from "../types.js";

/** Fallback strategy applied when a dialog is dismissed without an answer. */
export type UIOnTimeout = "recommended" | "first" | "cancel";

/** Where the resolved value came from. */
export type UIDialogSource =
  | "user"
  | "recommended"
  | "first"
  | "default"
  | "no-ui"
  | "cancelled";

export interface UIDialogOptions {
  /** Override timeout in ms. `0` or negative disables the timeout. */
  timeoutMs?: number;
  /** Fallback strategy for `select`. Defaults to `"recommended"`. */
  onTimeout?: UIOnTimeout;
  /** Fallback value for `confirm` when unanswered. Defaults to `false`. */
  defaultOnTimeout?: boolean;
}

export interface UIDialogResult<T> {
  value: T | null;
  timedOut: boolean;
  source: UIDialogSource;
}

/**
 * Structural subset of `ExtensionContext` used by the helpers.
 * Kept loose so unit tests can pass lightweight stubs.
 */
export interface UIDialogContext {
  ui: {
    select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
    input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined>;
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
  hasUI?: boolean;
  cwd?: string;
}

/** Default interaction timeout (3 minutes). */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 180_000;

const RECOMMENDED_MARKERS = ["(recommended)", "（推荐）", "[recommended]"];

function isRecommended(label: string): boolean {
  const lower = label.toLowerCase();
  return RECOMMENDED_MARKERS.some((marker) => lower.includes(marker));
}

function parseTimeoutSeconds(value: unknown): number | undefined {
  let seconds: number;
  if (typeof value === "number") {
    seconds = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    seconds = Number(value);
  } else {
    return undefined;
  }
  if (!Number.isFinite(seconds)) return undefined;
  if (seconds <= 0) return 0; // explicit "disabled" marker
  return seconds;
}

function readInteractionSeconds(configPath: string): number | undefined {
  try {
    if (!existsSync(configPath)) return undefined;
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const interaction = parsed?.interaction;
    if (!interaction || typeof interaction !== "object") return undefined;
    return parseTimeoutSeconds((interaction as Record<string, unknown>).timeout_seconds);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the interaction timeout in milliseconds.
 *
 * Order: project `.goo/config.json` -> user `~/.auto-goo/config.json` -> default.
 * Returns `undefined` when the timeout is explicitly disabled (`<= 0`).
 */
export function getInteractionTimeoutMs(ctx?: { cwd?: string }): number | undefined {
  const cwd = ctx?.cwd || process.cwd();
  const home = process.env.HOME || "";
  const candidates = [
    join(cwd, ".goo", "config.json"),
    home ? join(home, ".auto-goo", "config.json") : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const seconds = readInteractionSeconds(candidate);
    if (seconds === undefined) continue;
    return seconds <= 0 ? undefined : Math.round(seconds * 1000);
  }
  return DEFAULT_INTERACTION_TIMEOUT_MS;
}

function resolveTimeoutMs(ctx: UIDialogContext, opts?: UIDialogOptions): number | undefined {
  if (opts?.timeoutMs !== undefined) {
    return opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
  }
  return getInteractionTimeoutMs(ctx);
}

function dialogOpts(timeoutMs: number | undefined): { timeout?: number } | undefined {
  return timeoutMs === undefined ? undefined : { timeout: timeoutMs };
}

function notifyFallback(ctx: UIDialogContext, message: string): void {
  try {
    ctx.ui?.notify?.(message, "warning");
  } catch {
    /* notifications must never break the workflow */
  }
}

function timeoutHint(timeoutMs: number | undefined): string {
  const seconds = timeoutMs === undefined ? 0 : Math.round(timeoutMs / 1000);
  return `已按超时策略继续（${seconds || "∞"}s；设 interaction.timeout_seconds 调整，0 禁用）`;
}

/**
 * Select dialog with timeout fallback.
 *
 * On timeout the option marked "(Recommended)" is adopted; when no such option
 * exists the dialog resolves to `null` rather than guessing.
 */
export async function uiSelectDetailed(
  ctx: UIDialogContext,
  header: string,
  options: SelectOption[],
  opts?: UIDialogOptions,
): Promise<UIDialogResult<string>> {
  const timeoutMs = resolveTimeoutMs(ctx, opts);
  const labels = options.map((o) => o.label);
  const toValue = (label: string): string => options.find((o) => o.label === label)?.value ?? label;

  const strategy: UIOnTimeout = opts?.onTimeout ?? "recommended";
  const fallback = (timedOut: boolean, source?: UIDialogSource): UIDialogResult<string> => {
    if (strategy === "first" && options.length > 0) {
      notifyFallback(ctx, `⏱ 未在预期时间内响应：${header} → 采用第一项「${options[0].label}」。${timeoutHint(timeoutMs)}`);
      return { value: toValue(options[0].label), timedOut, source: source ?? "first" };
    }
    if (strategy === "recommended") {
      const picked = options.find((o) => isRecommended(o.label));
      if (picked) {
        notifyFallback(ctx, `⏱ 未在预期时间内响应：${header} → 采用推荐项「${picked.label}」。${timeoutHint(timeoutMs)}`);
        return { value: toValue(picked.label), timedOut, source: source ?? "recommended" };
      }
    }
    notifyFallback(ctx, `⏱ 未在预期时间内响应：${header} → 已取消（无可推荐项）。${timeoutHint(timeoutMs)}`);
    return { value: null, timedOut, source: "cancelled" };
  };

  if (ctx?.hasUI === false) return fallback(false, "no-ui");

  let label: string | undefined;
  try {
    label = await ctx.ui.select(header, labels, dialogOpts(timeoutMs));
  } catch {
    return fallback(true, "no-ui");
  }
  if (label === undefined || label === null || label === "") {
    return fallback(timeoutMs !== undefined);
  }
  return { value: toValue(label), timedOut: false, source: "user" };
}

/** Confirm dialog with timeout fallback (defaults to `false`). */
export async function uiConfirmDetailed(
  ctx: UIDialogContext,
  header: string,
  question: string,
  opts?: UIDialogOptions,
): Promise<UIDialogResult<boolean>> {
  const timeoutMs = resolveTimeoutMs(ctx, opts);
  const defaultValue = opts?.defaultOnTimeout ?? false;

  if (ctx?.hasUI === false) {
    return { value: defaultValue, timedOut: false, source: "no-ui" };
  }

  let result: boolean;
  try {
    result = await ctx.ui.confirm(header, question, dialogOpts(timeoutMs));
  } catch {
    return { value: defaultValue, timedOut: true, source: "no-ui" };
  }
  // Pi resolves `false` both for "No" and for a timeout; treat the returned
  // value as authoritative and only fall back when the default differs.
  if (result) return { value: true, timedOut: false, source: "user" };
  if (defaultValue) {
    notifyFallback(ctx, `⏱ 未在预期时间内响应：${header} → 采用默认值 true。${timeoutHint(timeoutMs)}`);
    return { value: true, timedOut: true, source: "default" };
  }
  return { value: false, timedOut: false, source: "user" };
}

/** Input dialog with timeout fallback to `defaultValue`. */
export async function uiInputDetailed(
  ctx: UIDialogContext,
  question: string,
  defaultValue = "",
  opts?: UIDialogOptions,
): Promise<UIDialogResult<string>> {
  const timeoutMs = resolveTimeoutMs(ctx, opts);
  const fallbackValue = defaultValue || null;

  if (ctx?.hasUI === false) {
    return { value: fallbackValue, timedOut: false, source: "no-ui" };
  }

  let result: string | undefined;
  try {
    result = await ctx.ui.input(question, defaultValue, dialogOpts(timeoutMs));
  } catch {
    return { value: fallbackValue, timedOut: true, source: "no-ui" };
  }
  if (result === undefined || result === null) {
    if (defaultValue) {
      notifyFallback(ctx, `⏱ 未在预期时间内响应：${question} → 采用默认值「${defaultValue}」。${timeoutHint(timeoutMs)}`);
    }
    return { value: fallbackValue, timedOut: timeoutMs !== undefined, source: "default" };
  }
  return { value: result || null, timedOut: false, source: "user" };
}

// ── Backwards-compatible wrappers ───────────────────────────────────────────
// Existing call sites keep their original signatures and gain timeout
// protection automatically.

/**
 * Show a select dialog with string labels, return the matching value.
 * Times out gracefully: adopts the "(Recommended)" option, else `null`.
 */
export async function uiSelect(
  ctx: ExtensionContext,
  header: string,
  options: SelectOption[],
  opts?: UIDialogOptions,
): Promise<string | null> {
  return (await uiSelectDetailed(ctx, header, options, opts)).value;
}

/** Show a confirm dialog; unanswered dialogs resolve to `false` by default. */
export async function uiConfirm(
  ctx: ExtensionContext,
  header: string,
  question: string,
  opts?: UIDialogOptions,
): Promise<boolean> {
  return (await uiConfirmDetailed(ctx, header, question, opts)).value ?? false;
}

/** Show an input dialog; unanswered dialogs resolve to `defaultValue`. */
export async function uiInput(
  ctx: ExtensionContext,
  question: string,
  defaultValue = "",
  opts?: UIDialogOptions,
): Promise<string | null> {
  return (await uiInputDetailed(ctx, question, defaultValue, opts)).value;
}
