import { decimalMax, intMax } from "../connect/typemap.js";
import type { ColumnModel } from "../connect/types.js";
import type { ColumnLimits } from "./checks.js";
import * as D from "./data.js";
import type { MeaningId } from "./meanings.js";
import { words } from "./meanings.js";
import type { Rng } from "./prng.js";

/**
 * Value models, one per meaning. A value depends only on the Rng it is given, which is
 * derived from (seed, table, column, row, attempt), so the same seed gives the same bytes.
 * Values respect the column's type, length, precision and any CHECK limits.
 */

/** Fixed reference date for "now", so output never depends on the day you run it. */
export const ANCHOR = Date.UTC(2026, 5, 30, 12, 0, 0);
const DAY = 86_400_000;

export interface ValueContext {
  rng: Rng;
  col: ColumnModel;
  table: string;
  ordinal: number;
  limits?: ColumnLimits;
  /** Allowed values from a rules file, code or samples. */
  values?: (string | number)[];
  /** Values already used in this row (a username can follow the person's name). */
  row: Record<string, unknown>;
}

const clampLen = (s: string, max?: number) => (max !== undefined && s.length > max ? s.slice(0, Math.max(0, max)) : s);

function textMax(ctx: ValueContext): number | undefined {
  const a = ctx.col.maxLength;
  const b = ctx.limits?.maxLength;
  if (a === undefined) return b === undefined || b === Infinity ? undefined : b;
  return b === undefined ? a : Math.min(a, b);
}

function personName(ctx: ValueContext): { first: string; last: string } {
  // Prefer the row's own name columns, so email and username match the person.
  const rowFirst = Object.entries(ctx.row).find(([k, v]) => typeof v === "string" && /first_?name|given_?name|fname/i.test(k))?.[1] as string | undefined;
  const rowLast = Object.entries(ctx.row).find(([k, v]) => typeof v === "string" && /last_?name|surname|family_?name|lname/i.test(k))?.[1] as string | undefined;
  const rowFull = Object.entries(ctx.row).find(([k, v]) => typeof v === "string" && /^(full_?name|name|display_?name)$/i.test(k))?.[1] as string | undefined;
  if (rowFirst || rowLast) return { first: rowFirst ?? ctx.rng.pick(D.FIRST_NAMES), last: rowLast ?? ctx.rng.pick(D.LAST_NAMES) };
  if (rowFull && rowFull.includes(" ")) {
    const [f, ...rest] = rowFull.split(" ");
    return { first: f!, last: rest.join(" ") };
  }
  return { first: ctx.rng.pick(D.FIRST_NAMES), last: ctx.rng.pick(D.LAST_NAMES) };
}

const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();

function cityRow(ctx: ValueContext): [string, string, string] {
  // Keep city, region and country consistent within a row when the row already has one.
  const known = Object.values(ctx.row).find((v) => typeof v === "string" && D.CITIES.some((c) => c[0] === v || c[2] === v || D.COUNTRIES[c[2]] === v));
  if (typeof known === "string") {
    const hit = D.CITIES.filter((c) => c[0] === known || c[2] === known || D.COUNTRIES[c[2]] === known);
    if (hit.length) return ctx.rng.pick(hit);
  }
  return ctx.rng.pick(D.CITIES);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function isoDateTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** A Sri Lankan NIC: old (9 digits + V/X) or new (12 digits). Encodes a plausible birth year and day. */
export function sriLankanNic(rng: Rng, format: "old" | "new"): string {
  const year = rng.int(1950, 2005);
  const female = rng.chance(0.5);
  const day = rng.int(1, 365) + (female ? 500 : 0);
  if (format === "old" && year < 2000) return `${String(year).slice(2)}${String(day).padStart(3, "0")}${rng.digits(4)}${rng.chance(0.95) ? "V" : "X"}`;
  return `${year}${String(day).padStart(3, "0")}${rng.digits(5)}`;
}

function moneyValue(ctx: ValueContext, lo = 0.5, hi = 2_000): number {
  const scale = ctx.col.type === "integer" ? 0 : (ctx.col.scale ?? 2);
  const max = Math.min(hi, ctx.col.type === "decimal" ? decimalMax(ctx.col) : ctx.col.type === "integer" ? intMax(ctx.col) : hi);
  // Log-uniform: many small amounts, a long tail of larger ones.
  const v = Math.exp(Math.log(lo) + ctx.rng.float() * (Math.log(Math.max(max, lo + 0.01)) - Math.log(lo)));
  return round(v, scale);
}

export function round(v: number, scale: number): number {
  const f = 10 ** Math.min(scale, 6);
  return Math.round(v * f) / f;
}

function sentence(ctx: ValueContext, min: number, max: number): string {
  const n = ctx.rng.int(min, max);
  const ws: string[] = [];
  for (let i = 0; i < n; i++) ws.push(ctx.rng.pick(D.WORDS));
  const s = ws.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function categoryFor(ctx: ValueContext): string[] {
  const w = words(ctx.col.name);
  return D.CATEGORY_VALUES[w[w.length - 1] ?? ""] ?? D.CATEGORY_VALUES.status!;
}

export function uuidV4(rng: Rng): string {
  const b: number[] = [];
  for (let i = 0; i < 16; i++) b.push(rng.int(0, 255));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The raw value for a meaning, before limits are applied. */
export function rawValue(meaning: MeaningId, ctx: ValueContext): unknown {
  const { rng, col } = ctx;
  const i = ctx.ordinal;
  const max = textMax(ctx);
  switch (meaning) {
    case "id":
    case "integer":
      return col.type === "text" ? `${ctx.table.slice(0, 3)}_${String(i + 1).padStart(6, "0")}` : meaning === "id" ? i + 1 : rng.int(0, Math.min(10_000, intMax(col)));
    case "reference":
      return null; // filled by the generator from a real parent row
    case "uuid":
      return uuidV4(rng);
    case "email": {
      const { first, last } = personName(ctx);
      const n = rng.chance(0.4) ? String(rng.int(1, 99)) : "";
      return `${ascii(first)}.${ascii(last)}${n}@${rng.skewed(D.DOMAINS, 1.2)}`;
    }
    case "phone": {
      const style = rng.int(0, 3);
      if (style === 0) return `+94 7${rng.int(0, 8)} ${rng.digits(3)} ${rng.digits(4)}`;
      if (style === 1) return `+1 ${rng.int(201, 989)}-555-${rng.digits(4)}`;
      if (style === 2) return `+44 7700 ${rng.digits(6)}`;
      return `+49 15${rng.digits(1)} ${rng.digits(7)}`;
    }
    case "first_name":
      return personName(ctx).first;
    case "last_name":
      return personName(ctx).last;
    case "full_name": {
      const { first, last } = personName(ctx);
      return `${first} ${last}`;
    }
    case "username": {
      const { first, last } = personName(ctx);
      return `${ascii(first)}${rng.chance(0.5) ? "_" : ""}${ascii(last).slice(0, 4)}${rng.int(1, 999)}`;
    }
    case "password_hash":
      return `$2b$10$${rng.alnum(53, "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`;
    case "token":
      return rng.alnum(Math.min(max ?? 40, 40), "abcdef0123456789");
    case "company":
      return `${rng.pick(D.COMPANY_WORDS)} ${rng.pick(D.COMPANY_SUFFIX)}${rng.chance(0.4) ? ` ${rng.pick(D.COMPANY_TYPE)}` : ""}`;
    case "job_title":
      return rng.pick(D.JOB_TITLES);
    case "title":
      return /product|item|sku|catalog/i.test(ctx.table) ? `${rng.pick(D.PRODUCT_ADJ)} ${rng.pick(D.PRODUCT_NOUN)}` : sentence(ctx, 2, 5);
    case "description":
      return Array.from({ length: rng.int(1, 3) }, () => rng.pick(D.SENTENCES)).join(" ");
    case "slug":
      return `${rng.pick(D.PRODUCT_ADJ)}-${rng.pick(D.PRODUCT_NOUN)}`.toLowerCase().replace(/[^a-z0-9]+/g, "-") + `-${i + 1}`;
    case "url":
      return /avatar|image|photo|logo|thumb/i.test(col.name) ? `https://img.example.com/${rng.alnum(10, "abcdefghijklmnopqrstuvwxyz0123456789")}.png` : `https://www.${ascii(rng.pick(D.COMPANY_WORDS))}.example/${rng.pick(D.WORDS)}`;
    case "domain":
      return `${ascii(rng.pick(D.COMPANY_WORDS))}${rng.int(1, 99)}.example`;
    case "ip_address":
      return rng.chance(0.85) ? `${rng.pick([10, 172, 192])}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}` : `2001:db8:${rng.alnum(4, "0123456789abcdef")}::${rng.int(1, 9999).toString(16)}`;
    case "sku":
      return `${rng.alnum(2, "ABCDEFGHJKLMNPQRSTUVWXYZ")}-${String(1000 + i).padStart(4, "0")}-${rng.alnum(3, "ABCDEFGHJKLMNPQRSTUVWXYZ")}`;
    case "national_id_lk": {
      const lengths = ctx.limits?.lengths;
      const canNew = (lengths ? lengths.includes(12) : true) && (max === undefined || max >= 12);
      const canOld = lengths ? lengths.includes(10) : true;
      return sriLankanNic(rng, canOld && (!canNew || rng.chance(0.5)) ? "old" : "new");
    }
    case "national_id":
      return `${rng.alnum(2, "ABCDEFGHJKLMNPQRSTUVWXYZ")}${rng.digits(7)}`;
    case "postal_code":
      return rng.digits(5);
    case "street":
      return `${rng.int(1, 420)} ${rng.pick(D.STREETS)}`;
    case "address": {
      const [city, , cc] = cityRow(ctx);
      return `${rng.int(1, 420)} ${rng.pick(D.STREETS)}, ${city}, ${D.COUNTRIES[cc]}`;
    }
    case "city":
      return cityRow(ctx)[0];
    case "region":
      return cityRow(ctx)[1];
    case "country":
      return D.COUNTRIES[cityRow(ctx)[2]];
    case "country_code":
      return cityRow(ctx)[2];
    case "currency_code":
      return rng.skewed(D.CURRENCIES, 1.4);
    case "language_code":
      return rng.skewed(D.LANGUAGES, 1.3);
    case "timezone":
      return rng.pick(D.TIMEZONES);
    case "latitude":
      return round(rng.float() * 140 - 60, Math.min(col.scale ?? 6, 6));
    case "longitude":
      return round(rng.float() * 340 - 170, Math.min(col.scale ?? 6, 6));
    case "money":
      return moneyValue(ctx);
    case "percent":
      return col.type === "integer" ? rng.int(0, 100) : round(rng.float() * 100, Math.min(col.scale ?? 2, 2));
    case "quantity":
      return Math.max(1, Math.round(Math.exp(rng.float() * Math.log(20))));
    case "count":
      return Math.floor(Math.exp(rng.float() * Math.log(5000))) - 1;
    case "age":
      return rng.int(18, 85);
    case "rating":
      return col.type === "integer" ? rng.int(1, 5) : round(1 + rng.float() * 4, 1);
    case "year":
      return rng.int(1995, 2026);
    case "birth_date":
      return isoDate(ANCHOR - (18 * 365 + rng.int(0, 60 * 365)) * DAY);
    case "date":
      return isoDate(ANCHOR - rng.int(-90, 3 * 365) * DAY);
    case "datetime":
      if (col.type === "integer") return Math.floor((ANCHOR - rng.int(0, 3 * 365 * DAY / 1000) * 1000) / 1000);
      return col.type === "date" ? isoDate(ANCHOR - rng.int(0, 3 * 365) * DAY) : isoDateTime(ANCHOR - rng.int(0, 3 * 365 * 24 * 3600) * 1000);
    case "time":
      return `${String(rng.int(6, 22)).padStart(2, "0")}:${String(rng.int(0, 3) * 15).padStart(2, "0")}:00`;
    case "boolean": {
      const mostlyFalse = /(deleted|archived|disabled|locked|banned|blocked|suspended|spam|test|deprecated)/i.test(col.name);
      const v = rng.chance(mostlyFalse ? 0.08 : 0.72);
      return v;
    }
    case "status":
      return rng.skewed(col.enumValues?.length ? col.enumValues : categoryFor(ctx), 1.5);
    case "color":
      return rng.pick(D.COLORS);
    case "mime_type":
      return rng.pick(D.MIME_TYPES);
    case "file_path":
      return `uploads/${String(2024 + (i % 3))}/${rng.alnum(8, "abcdefghijklmnopqrstuvwxyz0123456789")}.${rng.pick(["pdf", "png", "csv", "jpg"])}`;
    case "json":
      return JSON.stringify({ source: rng.pick(["web", "api", "import"]), version: rng.int(1, 4), tags: [rng.pick(D.WORDS), rng.pick(D.WORDS)] });
    case "bytes":
      return Buffer.from(Array.from({ length: 16 }, () => rng.int(0, 255)));
    case "number":
      return col.type === "integer" ? rng.int(0, 1000) : round(rng.float() * 1000, col.scale ?? 2);
    case "code":
      return rng.alnum(Math.max(1, Math.min(max ?? 8, 8)));
    case "text":
    default:
      return sentence(ctx, 2, 8);
  }
}

/**
 * Bring a value inside the column's limits: allowed values, lengths, numeric ranges,
 * type width and precision. Returns the adjusted value.
 */
export function fitValue(v: unknown, ctx: ValueContext): unknown {
  const { col, limits, rng } = ctx;
  if (v === null || v === undefined) return v;
  const allowed = limits?.values ?? ctx.values;
  if (allowed && allowed.length) {
    if (allowed.some((a) => String(a) === String(v))) return v;
    return coerce(rng.skewed(allowed, 1.3), col);
  }
  if (col.type === "enum" && col.enumValues?.length && !col.enumValues.includes(String(v))) return rng.skewed(col.enumValues, 1.5);

  if (typeof v === "number" && (col.type === "integer" || col.type === "decimal" || col.type === "real")) {
    let lo = -Infinity;
    let hi = Infinity;
    if (col.type === "integer") {
      hi = intMax(col);
      lo = /unsigned/i.test(col.rawType) ? 0 : -hi - 1;
    } else if (col.type === "decimal") {
      hi = decimalMax(col);
      lo = -hi;
    }
    const step = col.type === "integer" ? 1 : 10 ** -Math.min(col.scale ?? 2, 6);
    if (limits?.min !== undefined) lo = Math.max(lo, limits.minInclusive ? limits.min : limits.min + step);
    if (limits?.max !== undefined) hi = Math.min(hi, limits.maxInclusive ? limits.max : limits.max - step);
    let out = v;
    if (out < lo || out > hi) {
      // Map into the range rather than piling every value on the boundary.
      const span = hi - lo;
      out = Number.isFinite(span) ? lo + (Math.abs(out) % (span + step)) : out < lo ? lo + Math.abs(out % 1000) : hi - Math.abs(out % 1000);
      out = Math.min(hi, Math.max(lo, out));
    }
    out = col.type === "integer" ? Math.round(out) : round(out, col.scale ?? 6);
    if (limits?.notValues?.some((x) => Number(x) === out)) out = out + step <= hi ? round(out + step, 6) : round(out - step, 6);
    return out;
  }

  if (typeof v === "string") {
    let s = v;
    const max = textMax(ctx);
    const lengths = limits?.lengths;
    if (lengths && lengths.length && !lengths.includes(s.length)) {
      const fitting = lengths.filter((n) => max === undefined || n <= max);
      const target = fitting.length ? fitting.reduce((a, b) => (Math.abs(b - s.length) < Math.abs(a - s.length) ? b : a)) : lengths[0]!;
      s = s.length > target ? s.slice(0, target) : s + rng.alnum(target - s.length, "0123456789");
    }
    const minLen = limits?.minLength ?? 0;
    if (s.length < minLen) s += rng.alnum(minLen - s.length, "abcdefghijklmnopqrstuvwxyz");
    if (limits?.emailLike && !s.includes("@")) s = `${ascii(s).slice(0, 20) || "user"}@example.com`;
    s = clampLen(s, max);
    if (limits?.notValues?.includes(s)) s = clampLen(`${s}${ctx.ordinal}`, max);
    return s;
  }
  return v;
}

/** Coerce a value from a rules file or CHECK list to the column's type. */
export function coerce(v: string | number, col: ColumnModel): unknown {
  if (col.type === "integer" || col.type === "decimal" || col.type === "real") return Number(v);
  if (col.type === "boolean") return v === 1 || v === "1" || v === "true" || v === "t";
  return String(v);
}
