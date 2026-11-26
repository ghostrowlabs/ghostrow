import { VERSION } from "../version.js";
import { apiBase } from "./keys.js";

/**
 * The five licensing endpoints on ghostrow.com. Requests carry only a license key or an
 * activation token, a hashed machine ID, the machine's name and OS, and the CLI version.
 */

export interface ApiError {
  status: number;
  error: string;
  message: string;
  retryAfter?: number;
  extra: Record<string, unknown>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; err: ApiError };

export interface ActivationResponse {
  activation: string;
  license: string | null;
  plan: string;
  updates_until: string | null;
  expires_at: string;
  grace_until: string;
  machine?: { id: string; label: string | null };
  machines?: { active: number; limit: number | null };
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<ApiResult<T>> {
  const url = `${apiBase()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `ghostrow-cli/${VERSION}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const offline = e instanceof Error && (e.name === "TimeoutError" || /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? "")}`));
    return { ok: false, err: { status: 0, error: offline ? "offline" : "network", message: offline ? `Can't reach ${new URL(url).host}. Check your connection and try again.` : e instanceof Error ? e.message : String(e), extra: {} } };
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty or non-JSON body */
  }
  if (res.ok) return { ok: true, data: json as T };
  const retry = Number(res.headers.get("retry-after"));
  return {
    ok: false,
    err: {
      status: res.status,
      error: typeof json.error === "string" ? json.error : `http_${res.status}`,
      message: typeof json.message === "string" ? json.message : `The license server answered ${res.status}.`,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
      extra: json,
    },
  };
}

export const api = {
  activate: (body: { token: string; fingerprint: string; label?: string; os?: string; cliVersion?: string }) => call<ActivationResponse>("POST", "/api/v1/licenses/activate", body),
  refresh: (activation: string, timeoutMs?: number) => call<ActivationResponse>("POST", "/api/v1/licenses/refresh", { activation, cliVersion: VERSION }, timeoutMs),
  deactivate: (activation: string) => call<{ deactivated: boolean }>("POST", "/api/v1/licenses/deactivate", { activation }),
  validate: (token: string) => call<{ status: string; plan: string; updates_until: string | null; license: string | null }>("POST", "/api/v1/licenses/validate", { token }),
  revocations: (timeoutMs?: number) => call<{ revocations: string; count: number }>("GET", "/api/v1/revocations", undefined, timeoutMs),
  ci: (token: string, timeoutMs?: number) => call<{ license: string; plan: string; label: string | null }>("POST", "/api/v1/ci/verify", { token, cliVersion: VERSION }, timeoutMs),
};
