import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeTable } from "../../src/connect/types.js";
import { columnText } from "../../src/model/features.js";
import { MANIFEST_PREFIX, platformId, sha256, verifyManifest, type Manifest } from "../../src/model/manifest.js";
import { pullModel } from "../../src/model/pull.js";
import { installedModel, modelDir, runtimeDir } from "../../src/model/store.js";
import { BpeTokenizer } from "../../src/model/tokenizer.js";

function authority() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = { "test-1": publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  const signManifest = (m: Manifest) => {
    const payload = Buffer.from(JSON.stringify(m)).toString("base64url");
    return `${MANIFEST_PREFIX}.${payload}.${sign(null, Buffer.from(`${MANIFEST_PREFIX}.${payload}`), privateKey).toString("base64url")}`;
  };
  return { keys, signManifest };
}

const files: Record<string, Buffer> = {
  "model.onnx": Buffer.from("not really a model"),
  "tokenizer.json": Buffer.from("{}"),
  "model.json": Buffer.from('{"name":"gr-col-1"}'),
  [`ort-${platformId()}-onnxruntime_binding.node`]: Buffer.from("binding"),
};
function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    v: 1,
    kid: "test-1",
    name: "gr-col-1",
    version: "1.0.0",
    task: "column-meaning",
    feature_version: 1,
    released_at: "2026-11-27T00:00:00.000Z",
    files: Object.entries(files).map(([name, buf]) => ({
      name,
      role: name.startsWith("ort-") ? "runtime" : name === "model.onnx" ? "model" : name === "tokenizer.json" ? "tokenizer" : "info",
      ...(name.startsWith("ort-") ? { platform: platformId(), install_as: "onnxruntime_binding.node" } : {}),
      size: buf.length,
      sha256: sha256(buf),
    })),
    ...over,
  };
}

describe("model manifest", () => {
  const a = authority();
  it("verifies a signed manifest and rejects tampering or unknown keys", () => {
    const token = a.signManifest(manifest());
    expect(verifyManifest(token, a.keys).ok).toBe(true);
    const [p, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...manifest(), version: "9.9.9" })).toString("base64url");
    expect(verifyManifest(`${p}.${forged}.${sig}`, a.keys)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyManifest(token, authority().keys)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyManifest(a.signManifest(manifest({ kid: "nope" })), a.keys)).toEqual({ ok: false, reason: "unknown_key" });
    expect(verifyManifest(`${p}.${payload}`, a.keys)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("ghostrow model pull", () => {
  const a = authority();
  let server: Server;
  let serve: Record<string, Buffer> = {};
  const saved = { home: process.env.GHOSTROW_HOME, url: process.env.GHOSTROW_MODEL_URL };
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ghostrow-model-"));
    process.env.GHOSTROW_HOME = home;
    server = createServer((req, res) => {
      const body = serve[(req.url ?? "").replace(/^\/+/, "")];
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.GHOSTROW_MODEL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [["GHOSTROW_HOME", saved.home], ["GHOSTROW_MODEL_URL", saved.url]] as const) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });

  it("refuses a file that doesn't match the manifest and installs nothing", async () => {
    serve = { ...files, "manifest.grm": Buffer.from(a.signManifest(manifest())), "model.onnx": Buffer.from("not really a modeL") };
    await expect(pullModel("gr-col-1", () => undefined, a.keys)).rejects.toThrow(/doesn't match the signed manifest/);
    expect(installedModel("gr-col-1", a.keys)).toBeNull();
    expect(existsSync(join(modelDir(), "model.onnx"))).toBe(false);
  });

  it("refuses a manifest signed with another key", async () => {
    serve = { ...files, "manifest.grm": Buffer.from(authority().signManifest(manifest())) };
    await expect(pullModel("gr-col-1", () => undefined, a.keys)).rejects.toThrow(/didn't verify/);
  });

  it("installs a verified release, then keeps files that are already up to date", async () => {
    serve = { ...files, "manifest.grm": Buffer.from(a.signManifest(manifest())) };
    const first = await pullModel("gr-col-1", () => undefined, a.keys);
    expect(first.downloaded.sort()).toEqual(Object.keys(files).sort());
    expect(readFileSync(join(runtimeDir(), "onnxruntime_binding.node"), "utf8")).toBe("binding");
    const inst = installedModel("gr-col-1", a.keys);
    expect(inst?.runtime).toBe(true);
    expect(installedModel("gr-col-1", authority().keys)).toBeNull();
    const again = await pullModel("gr-col-1", () => undefined, a.keys);
    expect(again.downloaded).toEqual([]);
    expect(again.kept.length).toBe(Object.keys(files).length);
  });
});

describe("byte-level BPE tokenizer", () => {
  // A tiny vocabulary: single bytes (Ġ is the space byte), plus merges "u s", "us e", "Ġ id".
  const chars = ["[CLS]", "[SEP]", "[PAD]", "u", "s", "e", "r", "Ġ", "i", "d", "us", "use", "Ġi", "Ġid", ".", "_"];
  const tok = new BpeTokenizer({
    added_tokens: [
      { id: 0, content: "[CLS]", special: true },
      { id: 1, content: "[SEP]", special: true },
      { id: 2, content: "[PAD]", special: true },
    ],
    model: { type: "BPE", vocab: Object.fromEntries(chars.map((c, i) => [c, i])), merges: ["u s", "us e", "Ġ i", "Ġi d"] },
  });
  it("applies merges by rank and wraps with [CLS] … [SEP]", () => {
    expect(tok.encode("user id")).toEqual([0, 11, 6, 13, 1]);
    expect(tok.encode("user id", 4)).toEqual([0, 11, 6, 1]);
  });
});

describe("model features", () => {
  it("describes a column from schema text only", () => {
    const t = normalizeTable({
      name: "orderItems",
      columns: [
        { name: "id", type: "integer", rawType: "INTEGER", nullable: false, primaryKey: true, autoIncrement: true, unique: false },
        { name: "unitPrice", type: "decimal", rawType: "numeric(10, 2)", nullable: false, primaryKey: false, autoIncrement: false, unique: false, precision: 10, scale: 2 },
      ],
      primaryKey: ["id"],
      foreignKeys: [],
      uniques: [],
      checks: [],
    });
    expect(columnText(t, t.columns[1]!)).toBe("order items . unit price | decimal numeric(10, 2) | not null | near: id");
  });
});
