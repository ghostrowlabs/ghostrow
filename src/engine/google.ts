import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Google Application Default Credentials with fetch and node:crypto: GOOGLE_APPLICATION_CREDENTIALS,
 * then the gcloud ADC file (`gcloud auth application-default login`), then the metadata server on
 * Google Cloud. Covers user and service-account credentials; anything else (workload identity
 * federation, impersonation) can pass a token in GOOGLE_OAUTH_ACCESS_TOKEN.
 */

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT = 10_000;

interface AdcFile {
  type?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  quota_project_id?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
  project_id?: string;
}

export interface GoogleAuth {
  token: string;
  /** The project the credentials point at, if they name one. */
  project?: string;
}

export function adcPath(): string | undefined {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const dir =
    process.env.CLOUDSDK_CONFIG || (process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "gcloud") : join(homedir(), ".config", "gcloud"));
  const file = join(dir, "application_default_credentials.json");
  return existsSync(file) ? file : undefined;
}

export async function googleAuth(): Promise<GoogleAuth> {
  const path = adcPath();
  if (path) {
    const f = JSON.parse(readFileSync(path, "utf8")) as AdcFile;
    if (f.type === "authorized_user") return { token: await refresh(f), project: f.quota_project_id };
    if (f.type === "service_account") return { token: await serviceAccount(f), project: f.project_id };
    throw new Error(
      `Google credentials of type "${f.type}" aren't supported here. Pass a token instead: GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token).`,
    );
  }
  const md = await metadata().catch(() => null);
  if (md) return md;
  throw new Error(
    "no Google credentials found. Run `gcloud auth application-default login`, set GOOGLE_APPLICATION_CREDENTIALS, or set GOOGLE_OAUTH_ACCESS_TOKEN.",
  );
}

async function token(url: string, form: Record<string, string>): Promise<string> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`Google sign-in answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("Google sign-in returned no access token.");
  return j.access_token;
}

function refresh(f: AdcFile): Promise<string> {
  if (!f.client_id || !f.client_secret || !f.refresh_token) throw new Error("the Google user credentials file is incomplete.");
  return token(TOKEN_URL, { grant_type: "refresh_token", client_id: f.client_id, client_secret: f.client_secret, refresh_token: f.refresh_token });
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function serviceAccount(f: AdcFile): Promise<string> {
  if (!f.client_email || !f.private_key) throw new Error("the Google service account file has no client_email or private_key.");
  const aud = f.token_uri ?? TOKEN_URL;
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: f.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 }))}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(f.private_key);
  return token(aud, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` });
}

async function metadata(): Promise<GoogleAuth> {
  const host = process.env.GCE_METADATA_HOST ||"metadata.google.internal";
  const headers = { "metadata-flavor": "Google" };
  const r = await fetch(`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`, { headers, signal: AbortSignal.timeout(1_000) });
  if (!r.ok) throw new Error("no metadata server");
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("no metadata token");
  const p = await fetch(`http://${host}/computeMetadata/v1/project/project-id`, { headers, signal: AbortSignal.timeout(1_000) }).catch(() => null);
  return { token: j.access_token, project: p?.ok ? (await p.text()).trim() : undefined };
}
