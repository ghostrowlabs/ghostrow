/**
 * Synthetic schemas and application code with known rules: the ground-truth training data
 * for gr-rules-1. Each schema is assembled from scenarios (orders with lines, bookings,
 * contracts, tickets, ...). A scenario decides which columns exist, how they are named and
 * typed, and which rules hold between them; the answer for each table is written from that
 * decision, never from the CLI's heuristics. Distractors (tax_amount, refunds of a payment,
 * unrelated dates, constraints on another class in the same file) teach when *not* to
 * propose a rule. The vocabulary was written from general knowledge of how schemas and
 * validators are written, before the held-out files were read.
 *
 *   npx tsx training/rules/tools/synth.ts [schemas=9000] [seed=1] [out=training/rules/data/synth.jsonl]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ColumnModel, ColumnType, SchemaModel, TableModel } from "../../../src/connect/types.js";
import { normalizeTable } from "../../../src/connect/types.js";
import { codeContext, type CodeFile } from "../../../src/rulemodel/code.js";
import { answerText, askable, chatPrompt, tablePrompt, type Proposal } from "../../../src/rulemodel/format.js";

const SCHEMAS = Number(process.argv[2] ?? 9000);
let state = Number(process.argv[3] ?? 1) >>> 0;
const OUT = resolve(process.argv[4] ?? "training/rules/data/synth.jsonl");

function rand(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const shuffle = <T>(xs: T[]): T[] => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};

/* ------------------------------------------------------------------ naming */

type Style = "snake" | "camel" | "pascal";
let style: Style = "snake";
function words(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function styled(base: string, st: Style = style): string {
  const w = words(base);
  if (st === "snake") return w.join("_");
  const cap = w.map((x) => x[0]!.toUpperCase() + x.slice(1));
  return st === "pascal" ? cap.join("") : w[0]! + cap.slice(1).join("");
}
const camel = (s: string) => styled(s, "camel");
const pascal = (s: string) => styled(s, "pascal");
const singular = (s: string) => s.replace(/ies$/, "y").replace(/(ses|xes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");
function tableName(base: string): string {
  const b = chance(0.25) ? singular(base) : base;
  const prefixed = chance(0.08) ? `${pick(["app", "tbl", "core", "shop", "crm", "erp"])}_${b}` : b;
  return style === "pascal" ? pascal(prefixed) : style === "camel" && chance(0.5) ? pascal(prefixed) : styled(prefixed, "snake");
}

/* ------------------------------------------------------------------ types */

interface T {
  type: ColumnType;
  raw: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
}
const text = (n = pick([50, 100, 120, 200, 255])): T => (chance(0.15) ? { type: "text", raw: "text" } : { type: "text", raw: `varchar(${n})`, maxLength: n });
const char = (n: number): T => ({ type: "text", raw: `char(${n})`, maxLength: n });
const integer = (): T => ({ type: "integer", raw: pick(["integer", "int", "bigint", "smallint"]) });
const decimal = (p = pick([10, 12, 14, 18]), s = pick([2, 2, 2, 4])): T => (chance(0.08) ? { type: "real", raw: pick(["double precision", "float"]) } : { type: "decimal", raw: `numeric(${p},${s})`, precision: p, scale: s });
const money = () => (chance(0.12) ? integer() : decimal());
const date = (): T => ({ type: "date", raw: "date" });
const datetime = (): T => ({ type: "datetime", raw: pick(["timestamp", "timestamptz", "datetime"]) });
const time = (): T => ({ type: "time", raw: "time" });
const bool = (): T => ({ type: "boolean", raw: "boolean" });
const uuid = (): T => ({ type: "uuid", raw: "uuid" });
const json = (): T => ({ type: "json", raw: "jsonb" });
const hours = () => (chance(0.5) ? decimal(6, 2) : { type: "real", raw: "real" } as T);

/* ------------------------------------------------------------------ tables under construction */

interface Field {
  /** Base name (snake case, before styling). */
  base: string;
  name: string;
  t: T;
  nullable: boolean;
  pk?: boolean;
  unique?: boolean;
  ref?: Tab;
}
interface Tab {
  base: string;
  name: string;
  fields: Field[];
  gold: Proposal[];
  checks: string[];
  /** Constraints application code states for this table (written to files later). */
  code: CodeRule[];
}
type CodeRule =
  | { k: "min" | "max"; f: Field; v: number; strict?: boolean }
  | { k: "minlen" | "maxlen" | "len"; f: Field; v: number }
  | { k: "values"; f: Field; values: string[] }
  | { k: "order"; a: Field; b: Field }
  | { k: "product"; f: Field; a: Field; b: Field }
  | { k: "sum"; f: Field; child: Tab; c: Field };

function newTable(base: string, idType: "int" | "uuid" = chance(0.2) ? "uuid" : "int"): Tab {
  const t: Tab = { base, name: tableName(base), fields: [], gold: [], checks: [], code: [] };
  t.fields.push({ base: "id", name: chance(0.1) && style === "snake" ? `${singular(words(base).join("_"))}_id` : style === "pascal" ? "Id" : "id", t: idType === "uuid" ? uuid() : integer(), nullable: false, pk: true });
  return t;
}
function add(t: Tab, base: string, ty: T, nullable = chance(0.3)): Field {
  const existing = t.fields.find((f) => f.base === base);
  if (existing) return existing;
  const f: Field = { base, name: styled(base), t: ty, nullable };
  t.fields.push(f);
  return f;
}
function ref(child: Tab, parent: Tab, base = `${singular(words(parent.base).join("_"))}_id`, nullable = false): Field {
  const pk = parent.fields[0]!;
  const f: Field = { base, name: styled(base), t: { ...pk.t }, nullable, ref: parent };
  child.fields.push(f);
  return f;
}
const order = (t: Tab, a: Field, b: Field) => t.gold.push({ kind: "order", earlier: a.name, later: b.name, strict: false });

function audit(t: Tab, p = 0.8): Field | undefined {
  if (!chance(p)) return undefined;
  const created = add(t, pick(["created_at", "created_at", "created_at", "created", "date_created", "created_on", "inserted_at", "creation_date"]), datetime(), false);
  if (chance(0.75)) {
    const updated = add(t, pick(["updated_at", "updated_at", "modified_at", "last_modified", "updated", "date_modified", "changed_at"]), datetime(), chance(0.3));
    order(t, created, updated);
  }
  if (chance(0.15)) order(t, created, add(t, pick(["deleted_at", "archived_at", "removed_at"]), datetime(), true));
  return created;
}

/** Columns that sit next to rule columns without taking part in any rule. */
function filler(t: Tab, n: number): void {
  const pool: [string, () => T][] = [
    ["name", () => text()],
    ["title", () => text()],
    ["description", () => text()],
    ["notes", () => ({ type: "text", raw: "text" })],
    ["status", () => text(20)],
    ["code", () => text(32)],
    ["reference", () => text(40)],
    ["is_active", bool],
    ["metadata", json],
    ["sort_order", integer],
    ["priority", integer],
    ["version", integer],
    ["external_id", () => text(64)],
    ["color", () => char(7)],
    ["weight", () => decimal(8, 3)],
    ["rating", integer],
    ["score", () => decimal(5, 2)],
    ["views", integer],
    ["source", () => text(30)],
    ["retry_count", integer],
    ["error_count", integer],
    ["max_retries", integer],
    ["timeout_ms", integer],
    ["size_bytes", integer],
    ["daily_limit", integer],
    ["threshold", integer],
    ["usage_count", integer],
    ["seats", integer],
    ["latitude", () => decimal(9, 6)],
    ["longitude", () => decimal(9, 6)],
    ["last_synced_at", datetime],
    ["last_seen_at", datetime],
    ["next_run_at", datetime],
    ["locked_until", datetime],
    ["verified_at", datetime],
    ["expires_at", datetime],
    ["reminder_date", date],
    ["year", integer],
    ["month", integer],
    ["balance", money],
    ["credit_limit", money],
    ["fee", money],
  ];
  for (let i = 0; i < n; i++) {
    const [b, ty] = pick(pool);
    add(t, b, ty());
  }
}

/* ------------------------------------------------------------------ scenarios */

const HEADERS = [
  { base: "orders", lines: ["order_items", "order_lines", "line_items", "order_details", "order_products"], date: ["ordered_at", "placed_at", "order_date", "purchased_at", "submitted_at"] },
  { base: "invoices", lines: ["invoice_lines", "invoice_items", "line_items", "invoice_details"], date: ["issued_at", "invoice_date", "issue_date", "issued_on"] },
  { base: "purchase_orders", lines: ["purchase_order_lines", "po_lines", "purchase_order_items", "po_items"], date: ["order_date", "ordered_on", "raised_at"] },
  { base: "quotes", lines: ["quote_lines", "quote_items", "estimate_lines"], date: ["quoted_at", "quote_date", "issued_on"] },
  { base: "carts", lines: ["cart_items", "cart_lines", "basket_items"], date: ["opened_at", "started_at"] },
  { base: "receipts", lines: ["receipt_items", "receipt_lines"], date: ["issued_at", "receipt_date"] },
  { base: "bills", lines: ["bill_lines", "bill_items"], date: ["bill_date", "billed_at"] },
  { base: "sales", lines: ["sale_items", "sale_lines", "sales_details"], date: ["sold_at", "sale_date"] },
  { base: "credit_notes", lines: ["credit_note_lines", "credit_note_items"], date: ["issued_at", "credit_date"] },
  { base: "work_orders", lines: ["work_order_lines", "work_order_parts"], date: ["opened_at", "created_on"] },
];
const PRODUCTS = ["products", "items", "skus", "catalog_items", "articles", "parts", "menu_items", "services", "variants", "product_variants", "inventory_items", "goods"];
const PRODUCT_PRICE = ["price", "unit_price", "list_price", "base_price", "retail_price", "sale_price", "price_amount", "default_price", "standard_cost"];
const LINE_QTY = ["quantity", "qty", "quantity", "units", "num_units", "qty_ordered", "order_qty", "quantity_ordered", "pieces", "unit_count", "count"];
const LINE_PRICE = ["unit_price", "price", "unit_price", "unit_cost", "price_each", "rate", "unit_amount", "price_per_unit", "each_price", "item_price", "unit_rate"];
const LINE_AMOUNT = ["amount", "line_total", "total", "subtotal", "line_amount", "extended_price", "ext_price", "total_price", "line_price", "net_amount", "amount_total", "line_value", "item_total", "total_amount"];
const HEADER_TOTAL = ["total", "total_amount", "amount", "grand_total", "subtotal", "order_total", "total_price", "net_total", "total_value", "sum_total", "invoice_total", "items_total", "total_due", "amount_total", "lines_total", "net_amount"];
const HEADER_DISTRACT: [string, () => T][] = [
  ["tax_amount", money],
  ["tax", money],
  ["shipping_cost", money],
  ["shipping_fee", money],
  ["discount_amount", money],
  ["discount", money],
  ["freight", money],
  ["amount_refunded", money],
  ["deposit", money],
  ["exchange_rate", () => decimal(12, 6)],
  ["tip", money],
];
const LINE_DISTRACT: [string, () => T][] = [
  ["discount", money],
  ["discount_percent", () => decimal(5, 2)],
  ["tax_rate", () => decimal(5, 2)],
  ["tax_amount", money],
  ["weight", () => decimal(8, 3)],
  ["position", integer],
  ["line_number", integer],
  ["cost", money],
];

function commerce(schema: Tab[]): void {
  const h = pick(HEADERS);
  const header = newTable(h.base);
  let customer: Tab | undefined;
  if (chance(0.6)) {
    customer = newTable(pick(["customers", "clients", "accounts", "users", "buyers", "members"]));
    add(customer, pick(["name", "full_name", "company_name"]), text());
    add(customer, "email", text(254));
    if (chance(0.3)) add(customer, pick(["balance", "credit_limit", "lifetime_value", "total_spent"]), money());
    audit(customer, 0.6);
    ref(header, customer);
    schema.push(customer);
  }
  add(header, pick(["number", "reference", "code", `${singular(h.base)}_number`]), text(32), false);
  add(header, "status", chance(0.3) ? { type: "enum", raw: "status_enum", } as T : text(20), false);
  const f = header.fields.at(-1)!;
  if (f.t.type === "enum") f.t = { type: "enum", raw: "status_enum" };
  const placed = add(header, pick(h.date), chance(0.4) ? date() : datetime(), false);
  if (chance(0.7)) {
    const created = audit(header, 1);
    if (created && created !== placed && chance(0.3)) order(header, created, add(header, "confirmed_at", datetime(), true));
  }
  // Lifecycle after the order date.
  if (h.base === "orders" || h.base === "purchase_orders" || h.base === "sales") {
    let prev = placed;
    for (const step of shuffle([["paid_at", "payment_date"], ["shipped_at", "shipped_on", "ship_date", "dispatched_at"]]).slice(0, int(0, 2))) {
      const s = add(header, pick(step), prev.t.type === "date" ? date() : datetime(), true);
      order(header, prev, s);
      prev = s;
    }
    if (prev.base.startsWith("ship") || prev.base.startsWith("dispatch")) {
      if (chance(0.6)) order(header, prev, add(header, pick(["delivered_at", "received_at", "delivery_date"]), prev.t.type === "date" ? date() : datetime(), true));
    }
    if (chance(0.3)) order(header, placed, add(header, pick(["required_date", "due_date", "expected_delivery", "deliver_by"]), date(), true));
    if (chance(0.25)) order(header, placed, add(header, pick(["cancelled_at", "canceled_at"]), datetime(), true));
  }
  if (h.base === "invoices" || h.base === "bills" || h.base === "quotes" || h.base === "credit_notes") {
    if (chance(0.8)) order(header, placed, add(header, h.base === "quotes" ? pick(["valid_until", "expires_on", "expiry_date"]) : pick(["due_date", "due_on", "payment_due", "due_at"]), placed.t.type === "datetime" && chance(0.5) ? datetime() : date(), true));
    if (chance(0.5)) order(header, placed, add(header, pick(["paid_at", "paid_on", "settled_at"]), datetime(), true));
  }
  if (chance(0.5)) add(header, pick(["currency", "currency_code"]), char(3), false);

  const lines = newTable(pick(h.lines));
  const fk = ref(lines, header, chance(0.85) ? `${singular(words(h.base).join("_"))}_id` : pick(["parent_id", "header_id", "document_id"]));
  void fk;
  let product: Tab | undefined;
  let productPrice: Field | undefined;
  if (chance(0.7)) {
    product = newTable(pick(PRODUCTS));
    add(product, pick(["name", "title", "description"]), text(), false);
    add(product, pick(["sku", "code", "barcode"]), text(32));
    productPrice = chance(0.85) ? add(product, pick(PRODUCT_PRICE), money(), false) : undefined;
    if (chance(0.3)) add(product, pick(["cost", "cost_price", "purchase_price"]), money());
    if (chance(0.4)) add(product, pick(["stock", "stock_quantity", "quantity_on_hand", "in_stock"]), integer(), false);
    if (chance(0.3)) {
      const lo = add(product, "min_order_quantity", integer());
      const hi = add(product, "max_order_quantity", integer());
      order(product, lo, hi);
    }
    audit(product, 0.5);
    ref(lines, product, `${singular(words(product.base).join("_"))}_id`, chance(0.2));
    schema.push(product);
  }
  const qty = chance(0.85) ? add(lines, pick(LINE_QTY), chance(0.85) ? integer() : decimal(10, 3), false) : undefined;
  const price = chance(0.85) ? add(lines, pick(LINE_PRICE.filter((n) => n !== qty?.base)), money(), false) : undefined;
  const amountName = pick(LINE_AMOUNT.filter((n) => n !== price?.base));
  const amount = chance(0.8) ? add(lines, amountName, money(), false) : undefined;
  const lineDistract = shuffle([...LINE_DISTRACT]).slice(0, int(0, 2)).map(([b, ty]) => add(lines, b, ty()));
  if (chance(0.4)) add(lines, pick(["description", "name", "product_name"]), text());
  // Product rule: only when nothing on the line changes the amount (a discount or tax column might).
  const adjusts = lineDistract.some((d) => /discount|tax_amount/.test(d.base));
  if (qty && price && amount && !adjusts) lines.gold.push({ kind: "product", column: amount.name, factors: [qty.name, price.name] });
  // Copy rule: the line's unit price is the product's price at the time of the sale.
  if (product && productPrice && price && chance(0.9)) lines.gold.push({ kind: "copy", column: price.name, refTable: product.name, refColumn: productPrice.name });
  else if (product && productPrice && price) {
    // Same columns, but the line's price is negotiated: rename it so the difference is visible.
    price.base = pick(["negotiated_price", "custom_price", "override_price", "agreed_price"]);
    price.name = styled(price.base);
    if (lines.gold.at(-1)?.kind === "product") (lines.gold.at(-1) as Extract<Proposal, { kind: "product" }>).factors[1] = price.name;
  }
  const hCurrency = header.fields.find((x) => /^currency/.test(x.base));
  if (hCurrency && chance(0.35)) {
    const lc = add(lines, hCurrency.base, char(3), false);
    lines.gold.push({ kind: "copy", column: lc.name, refTable: header.name, refColumn: hCurrency.name });
  }
  // Header totals.
  const distract = shuffle([...HEADER_DISTRACT]).slice(0, int(0, 3)).map(([b, ty]) => add(header, b, ty()));
  void distract;
  const hasAdjust = header.fields.some((x) => /tax|shipping|discount|freight|tip/.test(x.base));
  if (amount && chance(0.85)) {
    // With tax or shipping on the header, only the subtotal is the sum of the lines.
    const totalName = hasAdjust ? pick(["subtotal", "items_total", "lines_total", "net_total", "sub_total"]) : pick(HEADER_TOTAL);
    const total = add(header, totalName, money(), false);
    header.gold.push({ kind: "sum", column: total.name, childTable: lines.name, childColumn: amount.name });
    if (hasAdjust && chance(0.6)) add(header, pick(["total", "grand_total", "total_amount", "amount_due"]), money(), false);
  } else if (chance(0.5)) {
    // A total with no line amount to sum (lines carry quantity and price only): no rule expressible.
    add(header, pick(HEADER_TOTAL), money(), false);
  }
  if (qty && chance(0.2)) {
    const count = add(header, pick(["item_count", "total_quantity", "total_items", "num_items", "units_total"]), integer(), false);
    header.gold.push({ kind: "sum", column: count.name, childTable: lines.name, childColumn: qty.name });
  }
  if (chance(0.3)) {
    // Payments against the document: amount_paid sums them; a refund table does not.
    const pay = newTable(pick(["payments", "transactions", "receipts_applied", "allocations"]));
    ref(pay, header);
    const pa = add(pay, pick(["amount", "amount_paid", "paid_amount", "value"]), money(), false);
    add(pay, pick(["paid_at", "payment_date", "received_at"]), datetime(), false);
    add(pay, pick(["method", "payment_method", "provider"]), text(30));
    if (chance(0.6)) {
      const paid = add(header, pick(["amount_paid", "paid_total", "total_paid", "paid_amount"]), money(), false);
      header.gold.push({ kind: "sum", column: paid.name, childTable: pay.name, childColumn: pa.name });
    }
    if (chance(0.5)) {
      const refund = newTable(pick(["refunds", "chargebacks", "reversals"]));
      ref(refund, pay, `${singular(words(pay.base).join("_"))}_id`);
      add(refund, "amount", money(), false);
      add(refund, pick(["reason", "note"]), text());
      order(refund, ...(() => {
        const a = add(refund, "requested_at", datetime(), false);
        const b = add(refund, pick(["processed_at", "completed_at", "refunded_at"]), datetime(), true);
        return [a, b] as const;
      })());
      schema.push(refund);
    }
    audit(pay, 0.5);
    schema.push(pay);
  }
  filler(header, int(0, 2));
  filler(lines, int(0, 1));
  audit(lines, 0.4);
  shuffleTail(header);
  shuffleTail(lines);
  // Code that enforces some of it.
  if (qty) codeLimits(lines, [[qty, 1, pick([99, 100, 999, 1000, 10000])]]);
  if (price && amount && qty && chance(0.25) && !adjusts) lines.code.push({ k: "product", f: amount, a: qty, b: price });
  schema.push(header, lines);
}

/** Keep the id first, move the rest around a little: real tables aren't in rule order. */
function shuffleTail(t: Tab): void {
  if (!chance(0.5)) return;
  const [id, ...rest] = t.fields;
  const fks = rest.filter((f) => f.ref);
  const others = shuffle(rest.filter((f) => !f.ref));
  t.fields = [id!, ...(chance(0.7) ? [...fks, ...others] : shuffle([...fks, ...others]))];
}

function codeLimits(t: Tab, limits: [Field, number, number][]): void {
  for (const [f, lo, hi] of limits) {
    if (!chance(0.5)) continue;
    if (chance(0.8)) t.code.push({ k: "min", f, v: lo });
    if (chance(0.6)) t.code.push({ k: "max", f, v: hi });
  }
}

/** Time ranges on a single table: bookings, contracts, events, ... */
const RANGES: { tables: string[]; pairs: [string, string, () => T][]; extra?: (t: Tab) => void }[] = [
  { tables: ["bookings", "reservations", "stays", "room_bookings"], pairs: [["check_in", "check_out", date], ["check_in_date", "check_out_date", date], ["arrival_date", "departure_date", date], ["checkin_at", "checkout_at", datetime], ["start_date", "end_date", date]] },
  { tables: ["subscriptions", "memberships", "plans_users", "licenses"], pairs: [["starts_at", "ends_at", datetime], ["start_date", "end_date", date], ["current_period_start", "current_period_end", datetime], ["trial_start", "trial_end", datetime], ["activated_at", "expires_at", datetime], ["valid_from", "valid_until", date]] },
  { tables: ["contracts", "leases", "agreements", "policies", "warranties"], pairs: [["start_date", "end_date", date], ["effective_date", "expiration_date", date], ["commencement_date", "termination_date", date], ["signed_on", "effective_date", date], ["lease_start", "lease_end", date], ["coverage_start", "coverage_end", date]] },
  { tables: ["events", "sessions", "meetings", "appointments", "shifts", "classes", "webinars"], pairs: [["starts_at", "ends_at", datetime], ["start_time", "end_time", datetime], ["begins_at", "finishes_at", datetime], ["scheduled_start", "scheduled_end", datetime], ["start_at", "end_at", datetime], ["doors_open_at", "starts_at", datetime], ["registration_opens_at", "registration_closes_at", datetime]] },
  { tables: ["flights", "trips", "rides", "journeys", "legs", "voyages"], pairs: [["departure_time", "arrival_time", datetime], ["departs_at", "arrives_at", datetime], ["pickup_at", "dropoff_at", datetime], ["scheduled_departure", "scheduled_arrival", datetime], ["started_at", "ended_at", datetime]] },
  { tables: ["tickets", "issues", "incidents", "cases", "support_requests"], pairs: [["opened_at", "resolved_at", datetime], ["reported_at", "acknowledged_at", datetime], ["created_at", "first_response_at", datetime], ["resolved_at", "closed_at", datetime], ["opened_on", "closed_on", date]] },
  { tables: ["jobs", "tasks", "builds", "runs", "deployments", "imports", "exports", "batches"], pairs: [["queued_at", "started_at", datetime], ["started_at", "finished_at", datetime], ["started_at", "completed_at", datetime], ["scheduled_for", "started_at", datetime], ["enqueued_at", "dequeued_at", datetime], ["start_time", "end_time", datetime]] },
  { tables: ["employees", "staff", "employments", "positions_held", "assignments"], pairs: [["hire_date", "termination_date", date], ["hired_on", "left_on", date], ["start_date", "end_date", date], ["joined_at", "left_at", datetime], ["date_hired", "date_terminated", date]] },
  { tables: ["enrollments", "registrations", "admissions", "courses", "terms", "semesters"], pairs: [["enrolled_on", "completed_on", date], ["admitted_at", "discharged_at", datetime], ["admission_date", "discharge_date", date], ["starts_on", "ends_on", date], ["term_start", "term_end", date], ["enrolled_at", "graduated_at", datetime]] },
  { tables: ["leave_requests", "absences", "vacations", "time_off_requests", "rentals", "loans", "borrowings"], pairs: [["start_date", "end_date", date], ["from_date", "to_date", date], ["date_from", "date_to", date], ["rented_at", "returned_at", datetime], ["borrowed_on", "returned_on", date], ["checkout_date", "due_date", date], ["rental_date", "return_date", datetime]] },
  { tables: ["promotions", "campaigns", "coupons", "discounts", "sales_events", "price_lists"], pairs: [["starts_at", "ends_at", datetime], ["valid_from", "valid_to", date], ["start_date", "end_date", date], ["active_from", "active_until", datetime], ["launch_date", "sunset_date", date], ["available_from", "available_until", datetime]] },
  { tables: ["projects", "milestones", "sprints", "phases", "budgets", "fiscal_periods", "pay_periods", "billing_periods"], pairs: [["start_date", "end_date", date], ["planned_start", "planned_end", date], ["period_start", "period_end", date], ["kickoff_date", "deadline", date], ["opens_on", "closes_on", date], ["begin_date", "finish_date", date]] },
  { tables: ["people", "persons", "patients", "members", "artists", "authors"], pairs: [["birth_date", "death_date", date], ["date_of_birth", "date_of_death", date], ["born_on", "died_on", date]] },
  { tables: ["auctions", "polls", "surveys", "elections", "votes_windows", "listings"], pairs: [["opens_at", "closes_at", datetime], ["start_time", "end_time", datetime], ["listed_at", "expires_at", datetime], ["published_at", "unpublished_at", datetime]] },
];
const NUM_RANGES: [string, string, () => T][] = [
  ["min_price", "max_price", money],
  ["min_age", "max_age", integer],
  ["min_quantity", "max_quantity", integer],
  ["min_players", "max_players", integer],
  ["min_salary", "max_salary", money],
  ["salary_min", "salary_max", money],
  ["minimum_amount", "maximum_amount", money],
  ["lower_bound", "upper_bound", () => decimal(12, 4)],
  ["low", "high", () => decimal(12, 4)],
  ["min_guests", "max_guests", integer],
  ["min_capacity", "max_capacity", integer],
  ["price_from", "price_to", money],
  ["min_temperature", "max_temperature", () => decimal(5, 2)],
  ["min_stay_nights", "max_stay_nights", integer],
  ["floor_price", "ceiling_price", money],
  ["min_score", "max_score", integer],
  ["minimum_order", "maximum_order", money],
  ["min_length", "max_length", integer],
  ["start_km", "end_km", () => decimal(10, 1)],
  ["odometer_start", "odometer_end", integer],
  ["opening_balance", "closing_balance", money],
];

function ranges(schema: Tab[]): void {
  const r = pick(RANGES);
  const t = newTable(pick(r.tables));
  add(t, pick(["name", "title", "reference", "description"]), text());
  const pairs = shuffle([...r.pairs]);
  const used: Field[] = [];
  const n = int(1, Math.min(2, pairs.length));
  for (const [a, b, ty] of pairs.slice(0, n)) {
    if (t.fields.some((f) => f.base === a || f.base === b)) {
      const fa = t.fields.find((f) => f.base === a) ?? add(t, a, ty(), false);
      const fb = t.fields.find((f) => f.base === b) ?? add(t, b, fa.t.type === "date" ? date() : ty(), true);
      if (fa !== fb && !t.gold.some((g) => g.kind === "order" && g.earlier === fb.name && g.later === fa.name)) order(t, fa, fb);
      continue;
    }
    const fa = add(t, a, ty(), chance(0.2));
    const fb = add(t, b, fa.t.type === "date" ? date() : fa.t.type === "datetime" ? datetime() : ty(), chance(0.5));
    order(t, fa, fb);
    used.push(fa, fb);
  }
  // Unrelated time columns next to the range: they take part in no rule.
  if (chance(0.5)) add(t, pick(["birth_date", "last_login_at", "review_date", "reminder_at", "last_synced_at", "anniversary_date", "renewal_notice_date"]), chance(0.5) ? date() : datetime(), true);
  if (chance(0.35)) {
    const [a, b, ty] = pick(NUM_RANGES);
    const fa = add(t, a, ty(), true);
    const fb = add(t, b, fa.t.type === "integer" ? integer() : ty(), true);
    order(t, fa, fb);
    if (chance(0.4)) t.code.push({ k: "order", a: fa, b: fb });
  }
  // Numeric columns that look alike but aren't ordered.
  if (chance(0.3)) {
    const [x, y] = pick([["width", "height"], ["price", "cost"], ["latitude", "longitude"], ["min_price", "max_weight"], ["capacity", "attendees"], ["deposit", "price"], ["adults", "children"]]);
    add(t, x!, integer(), true);
    add(t, y!, integer(), true);
  }
  // Duration × rate pricing on a booking-like table.
  if (chance(0.25)) {
    const units = add(t, pick(["nights", "days", "hours", "duration_hours", "num_days", "billable_hours"]), integer(), false);
    const rate = add(t, pick(["nightly_rate", "daily_rate", "hourly_rate", "rate", "price_per_night", "rate_per_day"]), money(), false);
    const total = add(t, pick(["total_price", "total", "amount", "total_cost", "charge"]), money(), false);
    t.gold.push({ kind: "product", column: total.name, factors: [units.name, rate.name] });
    if (chance(0.3)) t.code.push({ k: "product", f: total, a: units, b: rate });
  }
  const created = audit(t, 0.6);
  void created;
  filler(t, int(0, 3));
  shuffleTail(t);
  const range = t.gold.find((g) => g.kind === "order");
  if (range && range.kind === "order" && chance(0.35)) {
    const a = t.fields.find((f) => f.name === range.earlier)!;
    const b = t.fields.find((f) => f.name === range.later)!;
    t.code.push({ k: "order", a, b });
  }
  // A parent the range belongs to (a room, a member), sometimes with a rate the row copies.
  if (chance(0.5)) {
    const p = newTable(pick(["rooms", "customers", "members", "properties", "vehicles", "venues", "users", "accounts"]));
    add(p, pick(["name", "title", "label"]), text(), false);
    const pr = chance(0.4) ? add(p, pick(["nightly_rate", "daily_rate", "rate", "price"]), money(), false) : undefined;
    audit(p, 0.5);
    ref(t, p);
    const rate = t.fields.find((f) => /rate|price_per/.test(f.base));
    if (pr && rate && words(pr.base).at(-1) === words(rate.base).at(-1)) t.gold.push({ kind: "copy", column: rate.name, refTable: p.name, refColumn: pr.name });
    schema.push(p);
  }
  schema.push(t);
}

/** Header with entries that are summed, outside commerce: timesheets, expense reports, payroll, budgets. */
function aggregates(schema: Tab[]): void {
  const kinds = [
    { h: ["timesheets", "time_reports", "weekly_timesheets"], c: ["timesheet_entries", "time_entries", "entries", "timesheet_lines"], total: ["total_hours", "hours_total", "hours"], amount: ["hours", "duration_hours", "worked_hours"], ty: hours, priced: true },
    { h: ["expense_reports", "expense_claims", "reimbursements"], c: ["expenses", "expense_items", "expense_lines", "claim_items"], total: ["total_amount", "total", "amount", "claimed_total"], amount: ["amount", "cost", "value", "amount_claimed"], ty: money, priced: false },
    { h: ["payslips", "pay_stubs", "payroll_runs", "salary_slips"], c: ["payslip_lines", "earnings", "pay_items", "payroll_lines"], total: ["gross_pay", "gross_amount", "total_earnings", "gross"], amount: ["amount", "earning_amount", "value"], ty: money, priced: true },
    { h: ["budgets", "cost_centers", "projects"], c: ["budget_lines", "budget_items", "allocations"], total: ["total_budget", "budget_total", "allocated_total", "total"], amount: ["amount", "allocated_amount", "budgeted_amount"], ty: money, priced: false },
    { h: ["shipments", "consignments", "packages_batches"], c: ["parcels", "packages", "shipment_items"], total: ["total_weight", "gross_weight", "weight_total"], amount: ["weight", "weight_kg", "gross_weight"], ty: () => decimal(10, 3), priced: false },
    { h: ["playlists", "albums", "mixes"], c: ["tracks", "songs", "playlist_tracks"], total: ["total_duration", "duration_seconds", "total_seconds"], amount: ["duration", "duration_seconds", "seconds"], ty: integer, priced: false },
    { h: ["deposits_batches", "settlements", "payouts"], c: ["settlement_items", "payout_items", "deposit_items"], total: ["total_amount", "net_amount", "amount"], amount: ["amount", "net_amount", "gross_amount"], ty: money, priced: false },
    { h: ["journal_entries", "ledger_batches"], c: ["journal_lines", "ledger_lines", "postings"], total: ["total_debit", "debit_total"], amount: ["debit", "debit_amount"], ty: money, priced: false },
  ];
  const k = pick(kinds);
  const head = newTable(pick(k.h));
  add(head, pick(["name", "title", "reference", "description"]), text());
  const owner = newTable(pick(["employees", "users", "staff", "members", "accounts", "merchants"]));
  add(owner, pick(["name", "full_name"]), text(), false);
  if (chance(0.5)) add(owner, pick(["hourly_rate", "rate", "salary"]), money());
  ref(head, owner);
  const child = newTable(pick(k.c));
  ref(child, head);
  const amt = add(child, pick(k.amount), k.ty(), false);
  if (chance(0.85)) {
    const tot = add(head, pick(k.total.filter((n) => n !== amt.base) .concat(k.total[0]!)), k.ty(), false);
    head.gold.push({ kind: "sum", column: tot.name, childTable: child.name, childColumn: amt.name });
    if (chance(0.2)) head.code.push({ k: "sum", f: tot, child, c: amt });
  }
  if (k.priced && chance(0.5) && amt.t.type !== "integer") {
    const rate = add(child, pick(["rate", "hourly_rate", "unit_rate", "pay_rate"]), money(), false);
    const value = add(child, pick(["amount", "total", "pay", "value", "cost"]).replace(amt.base, "line_amount"), money(), false);
    if (value !== amt && value !== rate) child.gold.push({ kind: "product", column: value.name, factors: [amt.name, rate.name] });
  }
  if (chance(0.5)) {
    const a = add(head, pick(["period_start", "week_start", "start_date", "from_date"]), date(), false);
    const b = add(head, pick(["period_end", "week_end", "end_date", "to_date"]), date(), false);
    order(head, a, b);
  }
  if (chance(0.5)) {
    const s = add(head, pick(["submitted_at", "sent_at"]), datetime(), true);
    if (chance(0.7)) order(head, s, add(head, pick(["approved_at", "reviewed_at", "processed_at"]), datetime(), true));
  }
  add(child, pick(["description", "category", "note", "name"]), text());
  if (chance(0.5)) add(child, pick(["work_date", "incurred_on", "date", "entry_date"]), date(), false);
  audit(head, 0.5);
  audit(child, 0.3);
  filler(head, int(0, 2));
  shuffleTail(head);
  shuffleTail(child);
  schema.push(owner, head, child);
}

/** Stock and inventory: movement value = quantity × unit cost; no sums. */
function inventory(schema: Tab[]): void {
  const item = newTable(pick(PRODUCTS));
  add(item, pick(["name", "title"]), text(), false);
  const cost = chance(0.6) ? add(item, pick(["unit_cost", "standard_cost", "cost_price", "average_cost"]), money(), false) : undefined;
  if (chance(0.5)) {
    const a = add(item, pick(["reorder_level", "reorder_point", "min_stock", "safety_stock"]), integer());
    const b = add(item, pick(["max_stock", "maximum_stock", "stock_capacity"]), integer());
    order(item, a, b);
  }
  const mv = newTable(pick(["stock_movements", "inventory_transactions", "stock_moves", "goods_receipts", "stock_adjustments"]));
  ref(mv, item);
  if (chance(0.5)) {
    const wh = newTable(pick(["warehouses", "locations", "stores", "bins"]));
    add(wh, "name", text(), false);
    ref(mv, wh);
    schema.push(wh);
  }
  const q = add(mv, pick(["quantity", "qty", "quantity_change", "units"]), integer(), false);
  const uc = add(mv, pick(["unit_cost", "cost_per_unit", "unit_value", "cost"]), money(), false);
  if (chance(0.7)) {
    const tv = add(mv, pick(["total_cost", "total_value", "value", "extended_cost", "amount"]), money(), false);
    mv.gold.push({ kind: "product", column: tv.name, factors: [q.name, uc.name] });
  }
  if (cost && words(cost.base).at(-1) === "cost" && chance(0.7)) mv.gold.push({ kind: "copy", column: uc.name, refTable: item.name, refColumn: cost.name });
  else if (cost) {
    uc.base = pick(["actual_cost", "landed_cost", "received_cost"]);
    uc.name = styled(uc.base);
    const g = mv.gold.find((x) => x.kind === "product");
    if (g && g.kind === "product") g.factors[1] = uc.name;
  }
  add(mv, pick(["moved_at", "occurred_at", "transaction_date", "received_on"]), datetime(), false);
  add(mv, pick(["reason", "movement_type", "kind", "reference"]), text(30));
  audit(mv, 0.4);
  audit(item, 0.6);
  shuffleTail(mv);
  codeLimits(item, [[item.fields.find((f) => /stock|reorder/.test(f.base)) ?? q, 0, pick([100000, 1000000])]]);
  schema.push(item, mv);
}

/** Tables with no cross-column rule at all: profiles, logs, lookups, settings. */
function plain(schema: Tab[]): void {
  const t = newTable(pick(["users", "profiles", "audit_logs", "settings", "tags", "categories", "countries", "notifications", "api_keys", "comments", "posts", "pages", "files", "attachments", "addresses", "devices", "webhooks", "feature_flags", "reviews", "favorites"]));
  add(t, pick(["name", "title", "label", "key", "slug"]), text(), false);
  filler(t, int(1, 5));
  if (chance(0.5)) add(t, pick(["last_login_at", "sent_at", "read_at", "published_at", "verified_at", "expires_at", "last_used_at"]), datetime(), true);
  if (chance(0.3)) add(t, pick(["birth_date", "date_of_birth", "event_date"]), date(), true);
  if (chance(0.4)) add(t, pick(["amount", "price", "balance", "total", "credit"]), money());
  if (chance(0.3)) add(t, pick(["quantity", "count", "attempts", "retries", "views"]), integer());
  audit(t, 0.7);
  shuffleTail(t);
  schema.push(t);
}

/** A table whose real rules live in application code: validators of every common library. */
function validated(schema: Tab[]): void {
  const t = newTable(pick(["users", "accounts", "products", "listings", "reviews", "events", "coupons", "courses", "players", "vehicles", "rooms", "articles", "jobs", "applications", "donations", "tickets", "pets", "recipes"]));
  const specs: [string, () => T, (f: Field) => void][] = [
    ["username", () => text(pick([30, 50, 150])), (f) => strLen(t, f, pick([2, 3, 4]), pick([20, 30, 32, 50]))],
    ["email", () => text(254), (f) => chance(0.4) && t.code.push({ k: "maxlen", f, v: pick([254, 255, 320]) })],
    ["display_name", () => text(100), (f) => strLen(t, f, 1, pick([50, 64, 100]))],
    ["title", () => text(200), (f) => strLen(t, f, pick([1, 3, 5]), pick([80, 120, 200]))],
    ["slug", () => text(100), (f) => strLen(t, f, 3, pick([60, 100]))],
    ["bio", () => ({ type: "text", raw: "text" }), (f) => chance(0.7) && t.code.push({ k: "maxlen", f, v: pick([160, 280, 500, 1000, 2000]) })],
    ["password", () => text(255), (f) => chance(0.8) && t.code.push({ k: "minlen", f, v: pick([8, 10, 12]) })],
    ["country", () => char(2), (f) => chance(0.6) && t.code.push({ k: "len", f, v: 2 })],
    ["currency", () => char(3), (f) => chance(0.6) && t.code.push({ k: "len", f, v: 3 })],
    ["postal_code", () => text(10), (f) => strLen(t, f, pick([3, 4, 5]), 10)],
    ["phone", () => text(20), (f) => strLen(t, f, pick([7, 8, 10]), pick([15, 20]))],
    ["rating", integer, (f) => t.code.push({ k: "min", f, v: 1 }, { k: "max", f, v: pick([5, 5, 10]) })],
    ["stars", integer, (f) => t.code.push({ k: "min", f, v: pick([0, 1]) }, { k: "max", f, v: 5 })],
    ["age", integer, (f) => t.code.push({ k: "min", f, v: pick([0, 13, 16, 18]) }, { k: "max", f, v: pick([120, 130, 150]) })],
    ["quantity", integer, (f) => t.code.push({ k: "min", f, v: pick([0, 1]) }, ...(chance(0.6) ? [{ k: "max" as const, f, v: pick([99, 100, 999]) }] : []))],
    ["capacity", integer, (f) => t.code.push({ k: "min", f, v: 1 }, ...(chance(0.5) ? [{ k: "max" as const, f, v: pick([500, 1000, 10000]) }] : []))],
    ["price", money, (f) => t.code.push({ k: "min", f, v: 0 }, ...(chance(0.3) ? [{ k: "max" as const, f, v: pick([10000, 99999, 1000000]) }] : []))],
    ["discount_percent", () => decimal(5, 2), (f) => t.code.push({ k: "min", f, v: 0 }, { k: "max", f, v: 100 })],
    ["percentage", integer, (f) => t.code.push({ k: "min", f, v: 0 }, { k: "max", f, v: 100 })],
    ["year", integer, (f) => t.code.push({ k: "min", f, v: pick([1900, 1950, 2000]) }, { k: "max", f, v: pick([2100, 2099, 2030]) })],
    ["priority", integer, (f) => t.code.push({ k: "min", f, v: pick([0, 1]) }, { k: "max", f, v: pick([3, 5, 10]) })],
    ["weight_kg", () => decimal(8, 2), (f) => t.code.push({ k: "min", f, v: 0 })],
    ["duration_minutes", integer, (f) => t.code.push({ k: "min", f, v: pick([1, 5, 15]) }, { k: "max", f, v: pick([480, 600, 1440]) })],
    ["seats", integer, (f) => t.code.push({ k: "min", f, v: 1 }, { k: "max", f, v: pick([8, 9, 50]) })],
    ["status", () => text(20), (f) => t.code.push({ k: "values", f, values: pick([["draft", "published", "archived"], ["active", "inactive", "suspended"], ["pending", "approved", "rejected"], ["open", "closed"], ["new", "in_progress", "done"], ["pending", "paid", "failed", "refunded"]]) })],
    ["role", () => text(20), (f) => t.code.push({ k: "values", f, values: pick([["admin", "member", "viewer"], ["owner", "editor", "viewer"], ["user", "admin"], ["student", "teacher", "admin"]]) })],
    ["visibility", () => text(16), (f) => t.code.push({ k: "values", f, values: pick([["public", "private", "unlisted"], ["public", "private"], ["everyone", "friends", "only_me"]]) })],
    ["size", () => text(4), (f) => t.code.push({ k: "values", f, values: pick([["XS", "S", "M", "L", "XL"], ["small", "medium", "large"]]) })],
    ["gender", () => text(10), (f) => t.code.push({ k: "values", f, values: pick([["male", "female", "other"], ["M", "F", "X"], ["female", "male", "nonbinary", "unspecified"]]) })],
    ["level", () => text(20), (f) => t.code.push({ k: "values", f, values: pick([["beginner", "intermediate", "advanced"], ["low", "medium", "high"], ["junior", "mid", "senior"]]) })],
    ["sku", () => text(32), (f) => strLen(t, f, pick([4, 6, 8]), pick([16, 32]))],
    ["code", () => text(20), (f) => chance(0.5) ? t.code.push({ k: "len", f, v: pick([6, 8, 10]) }) : strLen(t, f, 4, 20)],
  ];
  for (const [b, ty, rule] of shuffle([...specs]).slice(0, int(3, 7))) rule(add(t, b, ty(), chance(0.3)));
  // A range validated in code (end after start).
  if (chance(0.35)) {
    const [a, b, ty] = pick([["starts_at", "ends_at", datetime], ["start_date", "end_date", date], ["valid_from", "valid_until", date], ["min_price", "max_price", money], ["min_age", "max_age", integer], ["opens_at", "closes_at", datetime]] as [string, string, () => T][]);
    const fa = add(t, a, ty(), false);
    const fb = add(t, b, fa.t.type === "integer" ? integer() : ty(), true);
    t.code.push({ k: "order", a: fa, b: fb });
    // Names alone say so too; the code confirms it.
    order(t, fa, fb);
  }
  // Fields the code declares but never constrains.
  filler(t, int(0, 2));
  audit(t, 0.6);
  shuffleTail(t);
  // Validator limits that are not rules on stored data (page sizes on a search form) go in a second class.
  schema.push(t);
}
function strLen(t: Tab, f: Field, lo: number, hi: number): void {
  if (chance(0.7)) t.code.push({ k: "minlen", f, v: lo });
  if (chance(0.8)) t.code.push({ k: "maxlen", f, v: f.t.maxLength !== undefined ? Math.min(hi, f.t.maxLength) : hi });
}

/** Ranges named from arbitrary stems, so the pattern is learned rather than a vocabulary. */
const STEMS = ["delivery", "billing", "booking", "trial", "grace", "maintenance", "service", "sync", "import", "coverage", "window", "session", "run", "shift", "batch", "offer", "contract", "sale", "campaign", "quiet", "retention", "support", "rental", "loan", "season", "event", "access", "pickup", "lease", "warranty", "license", "enrollment", "voting", "auction", "promo", "blackout", "freeze", "review", "audit", "exam", "membership", "stay", "visit", "sprint", "phase", "term", "slot", "tour"];
const STEM_PAIRS: ((s: string) => [string, string])[] = [
  (s) => [`${s}_start`, `${s}_end`],
  (s) => [`${s}_starts_at`, `${s}_ends_at`],
  (s) => [`${s}_start_date`, `${s}_end_date`],
  (s) => [`${s}_from`, `${s}_to`],
  (s) => [`${s}_from`, `${s}_until`],
  (s) => [`start_${s}`, `end_${s}`],
  (s) => [`first_${s}_at`, `last_${s}_at`],
  (s) => [`${s}_opened_at`, `${s}_closed_at`],
  (s) => [`${s}_began_at`, `${s}_finished_at`],
  (s) => [`planned_${s}_start`, `planned_${s}_end`],
  (s) => [`actual_${s}_start`, `actual_${s}_end`],
];
const NUM_STEMS = ["price", "age", "weight", "height", "speed", "temperature", "score", "rate", "budget", "salary", "distance", "duration", "size", "quantity", "order_qty", "stock", "guests", "players", "nights", "level", "value", "amount", "radius", "bid", "fare", "credit"];
const NUM_PAIRS: ((s: string) => [string, string])[] = [
  (s) => [`min_${s}`, `max_${s}`],
  (s) => [`${s}_min`, `${s}_max`],
  (s) => [`minimum_${s}`, `maximum_${s}`],
  (s) => [`lower_${s}`, `upper_${s}`],
  (s) => [`${s}_low`, `${s}_high`],
  (s) => [`${s}_floor`, `${s}_ceiling`],
  (s) => [`${s}_from`, `${s}_to`],
];
/** Part of a whole: a part can't exceed the whole it belongs to. */
const PART_WHOLE: [string, string, () => T][] = [
  ["quantity_shipped", "quantity", integer],
  ["shipped_quantity", "ordered_quantity", integer],
  ["qty_received", "qty_ordered", integer],
  ["rejected_qty", "received_qty", () => decimal(8, 2)],
  ["returned_quantity", "delivered_quantity", integer],
  ["scrapped_qty", "produced_qty", integer],
  ["amount_refunded", "amount", money],
  ["refunded_amount", "paid_amount", money],
  ["amount_used", "amount", money],
  ["used_amount", "total_amount", money],
  ["discount_amount", "gross_amount", money],
  ["completed_tasks", "total_tasks", integer],
  ["processed_rows", "total_rows", integer],
  ["seats_used", "seats_purchased", integer],
  ["downloaded_bytes", "total_bytes", integer],
  ["fulfilled_quantity", "requested_quantity", integer],
];
const NOT_ORDERED: [string, string][] = [["sms_sent", "sms_limit"], ["api_calls", "api_quota"], ["planned_start", "actual_start"], ["planned_end", "actual_end"], ["expected_at", "arrived_at"], ["estimated_cost", "actual_cost"], ["budget", "spent"], ["width", "height"], ["retries", "max_retries"]];

function generic(schema: Tab[]): void {
  const t = newTable(pick(["jobs", "accounts", "items", "records", "entries", "plans", "listings", "programs", "allocations", "reservations", "requests", "assets", "vouchers", "tickets", "machines", "projects", "orders", "units", "policies", "packages"]));
  add(t, pick(["name", "title", "code", "reference", "label"]), text(), false);
  for (let k = int(1, 2); k > 0; k--) {
    if (chance(0.55)) {
      const [a, b] = pick(STEM_PAIRS)(pick(STEMS));
      const ty = chance(0.5) ? date() : datetime();
      const fa = add(t, a, ty, chance(0.2));
      const fb = add(t, b, ty.type === "date" ? date() : datetime(), chance(0.5));
      if (fa !== fb) order(t, fa, fb);
    } else if (chance(0.5)) {
      const [a, b] = pick(NUM_PAIRS)(pick(NUM_STEMS));
      const ty = chance(0.5) ? integer() : decimal(12, 2);
      const fa = add(t, a, ty, true);
      const fb = add(t, b, { ...ty }, true);
      if (fa !== fb) order(t, fa, fb);
    } else {
      const [part, whole, ty] = pick(PART_WHOLE);
      const w = add(t, whole, ty(), false);
      const pt = add(t, part, { ...w.t }, chance(0.3));
      if (pt !== w) order(t, pt, w);
    }
  }
  // Look-alikes that are not ordered: different stems, or a usage and a limit (limits change).
  if (chance(0.5)) {
    const [x, y] = chance(0.5) ? pick(NOT_ORDERED) : [`min_${pick(NUM_STEMS)}`, `max_${pick(NUM_STEMS)}`];
    const sx = x.replace(/^(min|max)_/, "");
    const sy = y.replace(/^(min|max)_/, "");
    if (sx !== sy && !t.fields.some((f) => f.base === x || f.base === y)) {
      const ty = /_at$|start|end/.test(x) ? datetime() : integer();
      add(t, x, ty, true);
      add(t, y, { ...ty }, true);
    }
  }
  audit(t, 0.6);
  filler(t, int(1, 10));
  shuffleTail(t);
  schema.push(t);
}

/** CHECK constraints the schema declares: already rules, so never part of the answer. */
function declareChecks(t: Tab): void {
  const nums = t.fields.filter((f) => !f.pk && !f.ref && ["integer", "decimal", "real"].includes(f.t.type));
  if (nums.length && chance(0.3)) {
    for (const f of shuffle([...nums]).slice(0, int(1, 3))) {
      t.checks.push(pick([`${f.name} >= 0`, `${f.name} > 0`, `(${f.name} >= 0)`, `${f.name} BETWEEN 0 AND ${pick([5, 10, 100, 1000])}`, `${f.name} >= 1`]));
    }
  }
  const txt = t.fields.filter((f) => f.t.type === "text" && /status|state|kind|type/.test(f.base));
  if (txt.length && chance(0.3)) t.checks.push(`${txt[0]!.name} IN (${pick([["'draft'", "'open'", "'closed'"], ["'active'", "'inactive'"], ["'pending'", "'done'", "'failed'"]]).join(", ")})`);
  if (!txt.length && chance(0.1)) {
    const f = t.fields.find((x) => x.t.type === "text" && !x.pk);
    if (f) t.checks.push(`char_length(${f.name}) <= ${pick([63, 100, 255])}`);
  }
  // A declared ordering: the schema already has it, so the answer leaves it out.
  const orders = t.gold.filter((g) => g.kind === "order");
  if (orders.length && chance(0.15)) {
    const g = pick(orders) as Extract<Proposal, { kind: "order" }>;
    t.checks.push(pick([`${g.later} >= ${g.earlier}`, `(${g.later} >= ${g.earlier}) OR (${g.later} IS NULL)`, `${g.earlier} <= ${g.later}`, `${g.earlier} < ${g.later}`]));
    t.gold = t.gold.filter((x) => x !== g);
  }
}

/* ------------------------------------------------------------------ code writers */

type Lang = "zod" | "pydantic" | "django" | "laravel" | "classvalidator" | "joi" | "yup" | "rails" | "marshmallow" | "bean" | "go" | "dataannotations" | "sqlalchemy";
const LANGS: Lang[] = ["zod", "pydantic", "django", "laravel", "classvalidator", "joi", "yup", "rails", "marshmallow", "bean", "go", "dataannotations", "sqlalchemy"];
const FILE: Record<Lang, (m: string) => string> = {
  zod: (m) => pick([`src/schemas/${camel(m)}.ts`, `src/lib/validation/${camel(m)}.ts`, `app/${camel(m)}/schema.ts`]),
  pydantic: (m) => pick([`app/schemas/${words(m).join("_")}.py`, `api/models.py`, `src/${words(m).join("_")}/schemas.py`]),
  django: () => pick(["models.py", "app/models.py", "shop/models.py"]),
  laravel: (m) => `app/Http/Requests/Store${pascal(m)}Request.php`,
  classvalidator: (m) => pick([`src/${camel(m)}/dto/create-${words(m).join("-")}.dto.ts`, `src/dto/${camel(m)}.dto.ts`]),
  joi: (m) => pick([`validators/${camel(m)}.js`, `src/validation/${camel(m)}.validation.js`]),
  yup: (m) => pick([`src/forms/${camel(m)}Form.ts`, `src/validation/${camel(m)}.js`]),
  rails: (m) => `app/models/${words(m).join("_")}.rb`,
  marshmallow: (m) => pick([`app/schemas/${words(m).join("_")}.py`, "schemas.py"]),
  bean: (m) => `src/main/java/com/example/model/${pascal(m)}.java`,
  go: (m) => pick([`internal/model/${words(m).join("_")}.go`, "models/models.go"]),
  dataannotations: (m) => `Models/${pascal(m)}.cs`,
  sqlalchemy: (m) => pick([`app/models/${words(m).join("_")}.py`, "models.py"]),
};

/** How a field is spelled in code of each language. */
function fieldName(lang: Lang, f: Field): string {
  if (["zod", "classvalidator", "joi", "yup", "bean"].includes(lang)) return chance(0.85) ? camel(f.base) : f.name;
  if (lang === "go" || lang === "dataannotations") return pascal(f.base);
  return words(f.base).join("_");
}

interface Emitted {
  file: string;
  text: string;
  /** Rules this code states for the table, as proposals (column names are the table's). */
  rules: Proposal[];
}

const tsType = (f: Field) => (["integer", "decimal", "real"].includes(f.t.type) ? "number" : f.t.type === "boolean" ? "boolean" : f.t.type === "date" || f.t.type === "datetime" ? "Date" : "string");

function writeCode(t: Tab, schema: Tab[]): Emitted | null {
  if (!t.code.length) return null;
  const lang = pick(LANGS);
  const model = singular(words(t.base).join("_"));
  const rules: Proposal[] = [];
  const byField = new Map<Field, CodeRule[]>();
  for (const r of t.code) {
    if (r.k === "order" || r.k === "product" || r.k === "sum") continue;
    byField.set(r.f, [...(byField.get(r.f) ?? []), r]);
  }
  const special = t.code.filter((r) => r.k === "order" || r.k === "product" || r.k === "sum");
  // Fields mentioned without rules, so the model sees declarations that state nothing.
  const fields = t.fields.filter((f) => !f.pk && !f.ref && (byField.has(f) || chance(0.4) || special.some((s) => (s.k === "order" ? [s.a, s.b] : s.k === "product" ? [s.f, s.a, s.b] : [s.f]).includes(f))));
  const lines: string[] = [];
  const N = (f: Field) => fieldName(lang, f);
  const rs = (f: Field) => byField.get(f) ?? [];
  const get = (f: Field, k: CodeRule["k"]) => rs(f).find((r) => r.k === k) as (CodeRule & { v?: number; values?: string[] }) | undefined;
  const num = (f: Field) => ["integer", "decimal", "real"].includes(f.t.type);
  for (const f of fields) for (const r of rs(f)) {
    if (r.k === "values") rules.push({ kind: "values", column: f.name, values: r.values });
    else if (r.k === "min" || r.k === "max") rules.push({ kind: r.k, column: f.name, value: r.v });
    else if (r.k === "minlen" || r.k === "maxlen" || r.k === "len") rules.push({ kind: r.k, column: f.name, value: r.v });
  }
  const P = pascal(model);
  const q = (v: string) => `'${v}'`;
  const qq = (v: string) => `"${v}"`;

  switch (lang) {
    case "zod": {
      lines.push(`import { z } from "zod";`, "", `export const ${P}Schema = z.object({`);
      for (const f of fields) {
        let s = num(f) ? (f.t.type === "integer" ? "z.number().int()" : "z.number()") : f.t.type === "boolean" ? "z.boolean()" : f.t.type === "date" || f.t.type === "datetime" ? "z.coerce.date()" : "z.string()";
        const vals = get(f, "values");
        if (vals?.values) s = `z.enum([${vals.values.map(qq).join(", ")}])`;
        const mn = get(f, "min") ?? get(f, "minlen");
        const mx = get(f, "max") ?? get(f, "maxlen");
        const ln = get(f, "len");
        if (mn?.v !== undefined) s += mn.v === 0 && num(f) && chance(0.5) ? ".nonnegative()" : `.min(${mn.v})`;
        if (mx?.v !== undefined) s += `.max(${mx.v})`;
        if (ln?.v !== undefined) s += `.length(${ln.v})`;
        if (/email/.test(f.base)) s += ".email()";
        if (f.nullable) s += pick([".optional()", ".nullable()", ".nullish()"]);
        lines.push(`  ${N(f)}: ${s},`);
      }
      const ord = special.filter((s) => s.k === "order");
      lines.push(ord.length ? "})" : "});");
      for (const o of ord) if (o.k === "order") lines.push(`.refine((d) => !d.${N(o.b)} || d.${N(o.b)} >= d.${N(o.a)}, { message: "${words(o.b.base).join(" ")} must not be before ${words(o.a.base).join(" ")}", path: ["${N(o.b)}"] })`);
      if (ord.length) lines[lines.length - 1] += ";";
      break;
    }
    case "pydantic": {
      lines.push("from pydantic import BaseModel, Field, model_validator", "from typing import Literal, Optional", "", `class ${P}Create(BaseModel):`);
      for (const f of fields) {
        const vals = get(f, "values");
        let ty = vals?.values ? `Literal[${vals.values.map(qq).join(", ")}]` : num(f) ? (f.t.type === "integer" ? "int" : "float") : f.t.type === "boolean" ? "bool" : f.t.type === "date" ? "date" : f.t.type === "datetime" ? "datetime" : "str";
        const kw: string[] = [];
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), mxl = get(f, "maxlen"), ln = get(f, "len");
        if (mn) kw.push(`ge=${mn.v}`);
        if (mx) kw.push(`le=${mx.v}`);
        if (mnl) kw.push(`min_length=${mnl.v}`);
        if (mxl) kw.push(`max_length=${mxl.v}`);
        if (ln) kw.push(`min_length=${ln.v}`, `max_length=${ln.v}`);
        if (f.nullable) ty = `Optional[${ty}]`;
        lines.push(kw.length ? `    ${N(f)}: ${ty} = Field(${f.nullable ? "None, " : ""}${kw.join(", ")})` : `    ${N(f)}: ${ty}${f.nullable ? " = None" : ""}`);
      }
      for (const o of special) if (o.k === "order") lines.push("", "    @model_validator(mode=\"after\")", `    def check_${words(o.b.base).join("_")}(self):`, `        if self.${N(o.b)} is not None and self.${N(o.b)} < self.${N(o.a)}:`, `            raise ValueError("${N(o.b)} must be after ${N(o.a)}")`, "        return self");
      break;
    }
    case "django": {
      lines.push("from django.core.validators import MaxValueValidator, MinValueValidator, MinLengthValidator", "from django.core.exceptions import ValidationError", "from django.db import models", "", `class ${P}(models.Model):`);
      for (const f of fields) {
        const v: string[] = [];
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), vals = get(f, "values");
        if (mn) v.push(`MinValueValidator(${mn.v})`);
        if (mx) v.push(`MaxValueValidator(${mx.v})`);
        if (mnl) v.push(`MinLengthValidator(${mnl.v})`);
        if (get(f, "len")) v.push(`MinLengthValidator(${get(f, "len")!.v})`);
        const field = num(f) ? (f.t.type === "integer" ? "IntegerField" : "DecimalField") : f.t.type === "boolean" ? "BooleanField" : f.t.type === "date" ? "DateField" : f.t.type === "datetime" ? "DateTimeField" : f.t.maxLength ? "CharField" : "TextField";
        const args: string[] = [];
        const mxl = get(f, "maxlen") ?? get(f, "len");
        if (field === "CharField") args.push(`max_length=${mxl?.v ?? f.t.maxLength}`);
        else if (mxl && field === "TextField") v.push(`MaxLengthValidator(${mxl.v})`);
        if (field === "DecimalField") args.push(`max_digits=${f.t.precision ?? 10}`, `decimal_places=${f.t.scale ?? 2}`);
        if (vals?.values) args.push(`choices=[${vals.values.map((x) => `(${q(x)}, ${q(x[0]!.toUpperCase() + x.slice(1))})`).join(", ")}]`);
        if (v.length) args.push(`validators=[${v.join(", ")}]`);
        if (f.nullable) args.push("null=True", "blank=True");
        lines.push(`    ${N(f)} = models.${field}(${args.join(", ")})`);
      }
      for (const s of special) {
        if (s.k === "order") lines.push("", "    def clean(self):", `        if self.${N(s.b)} and self.${N(s.a)} and self.${N(s.b)} < self.${N(s.a)}:`, `            raise ValidationError({"${N(s.b)}": "Must be after ${N(s.a)}."})`);
        if (s.k === "product") lines.push("", "    def save(self, *args, **kwargs):", `        self.${N(s.f)} = self.${N(s.a)} * self.${N(s.b)}`, "        super().save(*args, **kwargs)");
        if (s.k === "sum") lines.push("", `    def recalculate(self):`, `        self.${N(s.f)} = sum(line.${fieldName(lang, s.c)} for line in self.${words(s.child.base).join("_")}.all())`, `        self.save(update_fields=["${N(s.f)}"])`);
      }
      break;
    }
    case "laravel": {
      lines.push("<?php", "", "namespace App\\Http\\Requests;", "", "use Illuminate\\Foundation\\Http\\FormRequest;", "", `class Store${P}Request extends FormRequest`, "{", "    public function rules(): array", "    {", "        return [");
      for (const f of fields) {
        const parts: string[] = [f.nullable ? "nullable" : "required"];
        const vals = get(f, "values");
        parts.push(num(f) ? (f.t.type === "integer" ? "integer" : "numeric") : f.t.type === "date" || f.t.type === "datetime" ? "date" : f.t.type === "boolean" ? "boolean" : "string");
        const mn = get(f, "min") ?? get(f, "minlen"), mx = get(f, "max") ?? get(f, "maxlen"), ln = get(f, "len");
        if (mn && mx && chance(0.4)) parts.push(`between:${mn.v},${mx.v}`);
        else {
          if (mn) parts.push(`min:${mn.v}`);
          if (mx) parts.push(`max:${mx.v}`);
        }
        if (ln) parts.push(`size:${ln.v}`);
        if (vals?.values) parts.push(`in:${vals.values.join(",")}`);
        const o = special.find((s) => s.k === "order" && s.b === f);
        if (o && o.k === "order") parts.push(`${pick(["after_or_equal", "after", "gte"])}:${N(o.a)}`);
        lines.push(`            '${N(f)}' => '${parts.join("|")}',`);
      }
      lines.push("        ];", "    }", "}");
      // `after:` is strict; `gte:` is for numbers. The rule kept is "not before".
      break;
    }
    case "classvalidator": {
      const imports = new Set<string>(["IsOptional"]);
      const body: string[] = [];
      for (const f of fields) {
        const dec: string[] = [];
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), mxl = get(f, "maxlen"), ln = get(f, "len"), vals = get(f, "values");
        if (num(f)) dec.push(f.t.type === "integer" ? "@IsInt()" : "@IsNumber()");
        else if (f.t.type === "date" || f.t.type === "datetime") dec.push("@IsDate()");
        else dec.push("@IsString()");
        if (mn) dec.push(`@Min(${mn.v})`);
        if (mx) dec.push(`@Max(${mx.v})`);
        if (mnl && mxl && chance(0.5)) dec.push(`@Length(${mnl.v}, ${mxl.v})`);
        else {
          if (mnl) dec.push(`@MinLength(${mnl.v})`);
          if (mxl) dec.push(`@MaxLength(${mxl.v})`);
        }
        if (ln) dec.push(`@Length(${ln.v}, ${ln.v})`);
        if (vals?.values) dec.push(`@IsIn([${vals.values.map(q).join(", ")}])`);
        if (f.nullable) dec.unshift("@IsOptional()");
        for (const d of dec) imports.add(/@(\w+)/.exec(d)![1]!);
        body.push(...dec.map((d) => `  ${d}`), `  ${N(f)}${f.nullable ? "?" : "!"}: ${tsType(f)};`, "");
      }
      lines.push(`import { ${[...imports].sort().join(", ")} } from "class-validator";`, "", `export class Create${P}Dto {`, ...body.slice(0, -1), "}");
      break;
    }
    case "joi": {
      lines.push("const Joi = require('joi');", "", `const ${camel(model)}Schema = Joi.object({`);
      for (const f of fields) {
        const vals = get(f, "values");
        let s = num(f) ? (f.t.type === "integer" ? "Joi.number().integer()" : "Joi.number()") : f.t.type === "date" || f.t.type === "datetime" ? "Joi.date()" : f.t.type === "boolean" ? "Joi.boolean()" : "Joi.string()";
        const mn = get(f, "min") ?? get(f, "minlen"), mx = get(f, "max") ?? get(f, "maxlen"), ln = get(f, "len");
        if (mn) s += `.min(${mn.v})`;
        if (mx) s += `.max(${mx.v})`;
        if (ln) s += `.length(${ln.v})`;
        if (vals?.values) s += `.valid(${vals.values.map(q).join(", ")})`;
        const o = special.find((x) => x.k === "order" && x.b === f);
        if (o && o.k === "order") s += `.min(Joi.ref('${N(o.a)}'))`;
        s += f.nullable ? ".allow(null)" : ".required()";
        lines.push(`  ${N(f)}: ${s},`);
      }
      lines.push("});", "", `module.exports = { ${camel(model)}Schema };`);
      break;
    }
    case "yup": {
      lines.push("import * as yup from 'yup';", "", `export const ${camel(model)}Schema = yup.object({`);
      for (const f of fields) {
        const vals = get(f, "values");
        let s = num(f) ? (f.t.type === "integer" ? "yup.number().integer()" : "yup.number()") : f.t.type === "date" || f.t.type === "datetime" ? "yup.date()" : f.t.type === "boolean" ? "yup.boolean()" : "yup.string()";
        const mn = get(f, "min") ?? get(f, "minlen"), mx = get(f, "max") ?? get(f, "maxlen"), ln = get(f, "len");
        if (mn) s += `.min(${mn.v})`;
        if (mx) s += `.max(${mx.v})`;
        if (ln) s += `.length(${ln.v})`;
        if (vals?.values) s += `.oneOf([${vals.values.map(q).join(", ")}])`;
        const o = special.find((x) => x.k === "order" && x.b === f);
        if (o && o.k === "order") s += `.min(yup.ref('${N(o.a)}'), '${words(o.b.base).join(" ")} must be after ${words(o.a.base).join(" ")}')`;
        s += f.nullable ? ".nullable()" : ".required()";
        lines.push(`  ${N(f)}: ${s},`);
      }
      lines.push("});");
      break;
    }
    case "rails": {
      lines.push(`class ${P} < ApplicationRecord`);
      for (const r of schema.filter((x) => x.fields.some((f) => f.ref === t))) lines.push(`  has_many :${words(r.base).join("_")}`);
      for (const f of fields) {
        const opts: string[] = [];
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), mxl = get(f, "maxlen"), ln = get(f, "len"), vals = get(f, "values");
        if (!f.nullable && chance(0.5)) opts.push("presence: true");
        if (mnl || mxl || ln) opts.push(`length: { ${[ln ? `is: ${ln.v}` : "", mnl ? `minimum: ${mnl.v}` : "", mxl ? `maximum: ${mxl.v}` : ""].filter(Boolean).join(", ")} }`);
        if (mn || mx) opts.push(`numericality: { ${[f.t.type === "integer" ? "only_integer: true" : "", mn ? `greater_than_or_equal_to: ${mn.v}` : "", mx ? `less_than_or_equal_to: ${mx.v}` : ""].filter(Boolean).join(", ")} }`);
        if (vals?.values) opts.push(chance(0.5) ? `inclusion: { in: %w[${vals.values.join(" ")}] }` : `inclusion: { in: [${vals.values.map(qq).join(", ")}] }`);
        if (opts.length) lines.push(`  validates :${N(f)}, ${opts.join(", ")}${f.nullable && chance(0.5) ? ", allow_nil: true" : ""}`);
      }
      for (const s of special) {
        if (s.k === "order") lines.push("  validate :" + `${N(s.b)}_after_${N(s.a)}`, "", "  private", "", `  def ${N(s.b)}_after_${N(s.a)}`, `    return if ${N(s.b)}.blank? || ${N(s.a)}.blank?`, `    errors.add(:${N(s.b)}, "must be after ${words(s.a.base).join(" ")}") if ${N(s.b)} < ${N(s.a)}`, "  end");
        if (s.k === "product") lines.push(`  before_save { self.${N(s.f)} = ${N(s.a)} * ${N(s.b)} }`);
        if (s.k === "sum") lines.push(`  def recalculate_${N(s.f)}!`, `    update!(${N(s.f)}: ${words(s.child.base).join("_")}.sum(:${fieldName(lang, s.c)}))`, "  end");
      }
      lines.push("end");
      break;
    }
    case "marshmallow": {
      lines.push("from marshmallow import Schema, fields, validate, validates_schema, ValidationError", "", `class ${P}Schema(Schema):`);
      for (const f of fields) {
        const v: string[] = [];
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), mxl = get(f, "maxlen"), ln = get(f, "len"), vals = get(f, "values");
        if (mn || mx) v.push(`validate.Range(${[mn ? `min=${mn.v}` : "", mx ? `max=${mx.v}` : ""].filter(Boolean).join(", ")})`);
        if (mnl || mxl) v.push(`validate.Length(${[mnl ? `min=${mnl.v}` : "", mxl ? `max=${mxl.v}` : ""].filter(Boolean).join(", ")})`);
        if (ln) v.push(`validate.Length(equal=${ln.v})`);
        if (vals?.values) v.push(`validate.OneOf([${vals.values.map(qq).join(", ")}])`);
        const ty = num(f) ? (f.t.type === "integer" ? "Integer" : "Decimal") : f.t.type === "date" ? "Date" : f.t.type === "datetime" ? "DateTime" : f.t.type === "boolean" ? "Boolean" : "String";
        const args = [f.nullable ? "allow_none=True" : "required=True", ...(v.length ? [`validate=${v.length === 1 ? v[0] : `[${v.join(", ")}]`}`] : [])];
        lines.push(`    ${N(f)} = fields.${ty}(${args.join(", ")})`);
      }
      for (const s of special) if (s.k === "order") lines.push("", "    @validates_schema", "    def check_range(self, data, **kwargs):", `        if data.get("${N(s.b)}") and data["${N(s.b)}"] < data["${N(s.a)}"]:`, `            raise ValidationError("${N(s.b)} must be after ${N(s.a)}")`);
      break;
    }
    case "bean": {
      lines.push("package com.example.model;", "", "import jakarta.validation.constraints.*;", "", "@Entity", `@Table(name = "${t.name}")`, `public class ${P} {`);
      for (const f of fields) {
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), mxl = get(f, "maxlen"), ln = get(f, "len"), vals = get(f, "values");
        if (!f.nullable) lines.push("    @NotNull");
        if (mn) lines.push(f.t.type === "integer" ? `    @Min(${mn.v})` : `    @DecimalMin("${mn.v}")`);
        if (mx) lines.push(f.t.type === "integer" ? `    @Max(${mx.v})` : `    @DecimalMax("${mx.v}")`);
        if (mnl || mxl) lines.push(`    @Size(${[mnl ? `min = ${mnl.v}` : "", mxl ? `max = ${mxl.v}` : ""].filter(Boolean).join(", ")})`);
        if (ln) lines.push(`    @Size(min = ${ln.v}, max = ${ln.v})`);
        if (vals?.values) lines.push(`    @Pattern(regexp = "${vals.values.join("|")}")`);
        const jt = num(f) ? (f.t.type === "integer" ? "Integer" : "BigDecimal") : f.t.type === "date" ? "LocalDate" : f.t.type === "datetime" ? "Instant" : f.t.type === "boolean" ? "Boolean" : "String";
        lines.push(`    @Column(name = "${f.name}")`, `    private ${jt} ${N(f)};`, "");
      }
      for (const s of special) if (s.k === "order") lines.push(`    @AssertTrue(message = "${N(s.b)} must be after ${N(s.a)}")`, `    public boolean is${pascal(s.b.base)}Valid() {`, `        return ${N(s.b)} == null || !${N(s.b)}.isBefore(${N(s.a)});`, "    }", "");
      for (const s of special) if (s.k === "product") lines.push("    @PrePersist @PreUpdate", "    void computeTotal() {", `        this.${N(s.f)} = this.${N(s.b)}.multiply(BigDecimal.valueOf(this.${N(s.a)}));`, "    }");
      lines.push("}");
      break;
    }
    case "go": {
      lines.push("package model", "", `type ${P} struct {`);
      for (const f of fields) {
        const tags: string[] = [f.nullable ? "omitempty" : "required"];
        const mn = get(f, "min") ?? get(f, "minlen"), mx = get(f, "max") ?? get(f, "maxlen"), ln = get(f, "len"), vals = get(f, "values");
        if (mn) tags.push(num(f) ? `gte=${mn.v}` : `min=${mn.v}`);
        if (mx) tags.push(num(f) ? `lte=${mx.v}` : `max=${mx.v}`);
        if (ln) tags.push(`len=${ln.v}`);
        if (vals?.values) tags.push(`oneof=${vals.values.join(" ")}`);
        const o = special.find((x) => x.k === "order" && x.b === f);
        if (o && o.k === "order") tags.push(`gtefield=${N(o.a)}`);
        const gt = num(f) ? (f.t.type === "integer" ? "int" : "float64") : f.t.type === "date" || f.t.type === "datetime" ? "time.Time" : f.t.type === "boolean" ? "bool" : "string";
        lines.push(`\t${N(f)} ${f.nullable ? "*" : ""}${gt} \`json:"${words(f.base).join("_")}" db:"${f.name}" validate:"${tags.join(",")}"\``);
      }
      lines.push("}");
      break;
    }
    case "dataannotations": {
      lines.push("using System.ComponentModel.DataAnnotations;", "", "namespace App.Models;", "", `public class ${P}`, "{");
      for (const f of fields) {
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), mxl = get(f, "maxlen"), ln = get(f, "len"), vals = get(f, "values");
        if (!f.nullable) lines.push("    [Required]");
        if (mn && mx) lines.push(`    [Range(${mn.v}, ${mx.v})]`);
        else if (mn) lines.push(`    [Range(${mn.v}, ${f.t.type === "integer" ? "int.MaxValue" : "double.MaxValue"})]`);
        else if (mx) lines.push(`    [Range(${f.t.type === "integer" ? "int.MinValue" : "double.MinValue"}, ${mx.v})]`);
        if (mxl) lines.push(mnl ? `    [StringLength(${mxl.v}, MinimumLength = ${mnl.v})]` : `    [MaxLength(${mxl.v})]`);
        else if (mnl) lines.push(`    [MinLength(${mnl.v})]`);
        if (ln) lines.push(`    [StringLength(${ln.v}, MinimumLength = ${ln.v})]`);
        if (vals?.values) lines.push(`    [RegularExpression("^(${vals.values.join("|")})$")]`);
        const ct = num(f) ? (f.t.type === "integer" ? "int" : "decimal") : f.t.type === "date" || f.t.type === "datetime" ? "DateTime" : f.t.type === "boolean" ? "bool" : "string";
        lines.push(`    public ${ct}${f.nullable ? "?" : ""} ${N(f)} { get; set; }`, "");
      }
      lines.push("}");
      // Range with int.MaxValue / MinValue states only one side.
      break;
    }
    case "sqlalchemy": {
      lines.push("from sqlalchemy.orm import validates", "from .db import Base, Column, Integer, Numeric, String, DateTime, Date", "", `class ${P}(Base):`, `    __tablename__ = "${t.name}"`, "");
      for (const f of fields) {
        const ty = num(f) ? (f.t.type === "integer" ? "Integer" : `Numeric(${f.t.precision ?? 10}, ${f.t.scale ?? 2})`) : f.t.type === "date" ? "Date" : f.t.type === "datetime" ? "DateTime" : f.t.maxLength ? `String(${f.t.maxLength})` : "String";
        lines.push(`    ${N(f)} = Column(${ty}${f.nullable ? "" : ", nullable=False"})`);
      }
      for (const f of fields) {
        const mn = get(f, "min"), mx = get(f, "max"), mnl = get(f, "minlen"), mxl = get(f, "maxlen"), ln = get(f, "len"), vals = get(f, "values");
        const conds: string[] = [];
        if (mn) conds.push(`value < ${mn.v}`);
        if (mx) conds.push(`value > ${mx.v}`);
        if (mnl) conds.push(`len(value) < ${mnl.v}`);
        if (mxl) conds.push(`len(value) > ${mxl.v}`);
        if (ln) conds.push(`len(value) != ${ln.v}`);
        if (vals?.values) conds.push(`value not in (${vals.values.map(qq).join(", ")})`);
        if (!conds.length) continue;
        lines.push("", `    @validates("${N(f)}")`, `    def validate_${N(f)}(self, key, value):`, `        if value is not None and (${conds.join(" or ")}):`, `            raise ValueError("invalid ${N(f)}")`, "        return value");
      }
      for (const s of special) if (s.k === "order") lines.push("", `    @validates("${N(s.b)}")`, `    def validate_${N(s.b)}(self, key, value):`, `        if value is not None and self.${N(s.a)} is not None and value < self.${N(s.a)}:`, `            raise ValueError("${N(s.b)} must be after ${N(s.a)}")`, "        return value");
      break;
    }
  }
  // What the code states about cross-column rules. Order rules from code are also in the gold
  // set already (the names say so), product and sum likewise; code only adds evidence.
  for (const s of special) {
    if (s.k === "order" && !t.gold.some((g) => g.kind === "order" && g.earlier === s.a.name && g.later === s.b.name)) t.gold.push({ kind: "order", earlier: s.a.name, later: s.b.name, strict: false });
    if (s.k === "product" && !t.gold.some((g) => g.kind === "product" && g.column === s.f.name)) t.gold.push({ kind: "product", column: s.f.name, factors: [s.a.name, s.b.name] });
  }
  // Some languages above can't state a rule the way it was asked for; drop those from the answer.
  const stated = rules.filter((r) => {
    if (lang === "bean" && r.kind === "values") return true;
    if (lang === "django" && r.kind === "maxlen") return true;
    return true;
  });
  // A second, unrelated class in the same file sometimes: its limits are not this table's.
  if (chance(0.25)) {
    const other = pick(["SearchParams", "PaginationQuery", "LoginForm", "ContactForm", "FilterOptions"]);
    const lim = pick([["page", "1", "1000"], ["limit", "1", "100"], ["per_page", "1", "200"], ["page_size", "5", "50"]]);
    const fn = lang === "go" || lang === "dataannotations" ? pascal(lim[0]!) : ["zod", "classvalidator", "joi", "yup", "bean"].includes(lang) ? camel(lim[0]!) : lim[0]!;
    const extra = {
      zod: [`export const ${other} = z.object({ ${fn}: z.number().int().min(${lim[1]}).max(${lim[2]}) });`],
      pydantic: [`class ${other}(BaseModel):`, `    ${fn}: int = Field(1, ge=${lim[1]}, le=${lim[2]})`],
      django: [`class ${other}(forms.Form):`, `    ${fn} = forms.IntegerField(min_value=${lim[1]}, max_value=${lim[2]})`],
      laravel: [`// ${other}: '${fn}' => 'integer|min:${lim[1]}|max:${lim[2]}'`],
      classvalidator: [`export class ${other} {`, `  @Min(${lim[1]}) @Max(${lim[2]})`, `  ${fn}?: number;`, "}"],
      joi: [`const ${camel(other)} = Joi.object({ ${fn}: Joi.number().min(${lim[1]}).max(${lim[2]}) });`],
      yup: [`export const ${camel(other)} = yup.object({ ${fn}: yup.number().min(${lim[1]}).max(${lim[2]}) });`],
      rails: [`# ${other}: params[:${fn}].to_i.clamp(${lim[1]}, ${lim[2]})`],
      marshmallow: [`class ${other}(Schema):`, `    ${fn} = fields.Integer(validate=validate.Range(min=${lim[1]}, max=${lim[2]}))`],
      bean: [`// ${other}: @Min(${lim[1]}) @Max(${lim[2]}) int ${fn};`],
      go: [`type ${other} struct {`, `\t${fn} int \`validate:"gte=${lim[1]},lte=${lim[2]}"\``, "}"],
      dataannotations: [`public class ${other} { [Range(${lim[1]}, ${lim[2]})] public int ${fn} { get; set; } }`],
      sqlalchemy: [`# ${other}: ${fn} between ${lim[1]} and ${lim[2]}`],
    }[lang];
    if (chance(0.5)) lines.push("", ...extra);
    else lines.unshift(...extra, "");
  }
  return { file: FILE[lang](model), text: lines.join("\n"), rules: stated };
}

/* ------------------------------------------------------------------ assembly */

function toTableModel(t: Tab): TableModel {
  const columns: ColumnModel[] = t.fields.map((f) => ({
    name: f.name,
    type: f.t.type,
    rawType: f.t.raw,
    nullable: f.pk ? false : f.nullable,
    primaryKey: !!f.pk,
    autoIncrement: !!f.pk && f.t.type === "integer",
    unique: !!f.unique,
    ...(f.t.maxLength !== undefined ? { maxLength: f.t.maxLength } : {}),
    ...(f.t.precision !== undefined ? { precision: f.t.precision, scale: f.t.scale } : {}),
    ...(f.t.type === "enum" ? { enumValues: ["draft", "open", "closed"] } : {}),
  }));
  const foreignKeys = t.fields.filter((f) => f.ref).map((f) => ({ columns: [f.name], refTable: f.ref!.name, refColumns: [f.ref!.fields[0]!.name] }));
  return normalizeTable({ name: t.name, columns, primaryKey: [t.fields[0]!.name], foreignKeys, uniques: [], checks: t.checks });
}

const SCENARIOS: [number, (s: Tab[]) => void][] = [
  [0.34, commerce],
  [0.26, ranges],
  [0.12, aggregates],
  [0.08, inventory],
  [0.1, validated],
  [0.1, plain],
  [0.14, generic],
];
function scenario(): (s: Tab[]) => void {
  let r = rand();
  for (const [p, f] of SCENARIOS) {
    if ((r -= p) < 0) return f;
  }
  return plain;
}

interface Example {
  id: string;
  table: string;
  user: string;
  prompt: string;
  answer: string;
  code: boolean;
  kinds: string[];
}

const out: Example[] = [];
for (let n = 0; n < SCHEMAS; n++) {
  style = pick(["snake", "snake", "snake", "snake", "camel", "pascal"]);
  const tabs: Tab[] = [];
  for (let k = int(1, 3); k > 0; k--) scenario()(tabs);
  // Table names must be unique within a schema.
  const seen = new Set<string>();
  for (const t of tabs) {
    while (seen.has(t.name.toLowerCase())) t.name = `${t.name}${style === "snake" ? "_" : ""}${int(2, 9)}`;
    seen.add(t.name.toLowerCase());
  }
  // Fix rules that named a table before it was renamed.
  for (const t of tabs) for (const g of t.gold) if (g.kind === "sum" || g.kind === "copy") {
    const target = tabs.find((x) => (g.kind === "sum" ? x.fields.some((f) => f.ref === t) : t.fields.some((f) => f.ref === x)) && (g.kind === "sum" ? x.fields.some((f) => f.name === g.childColumn) : x.fields.some((f) => f.name === g.refColumn)));
    if (target) g.kind === "sum" ? (g.childTable = target.name) : (g.refTable = target.name);
  }
  for (const t of tabs) declareChecks(t);
  const models = new Map(tabs.map((t) => [t, toTableModel(t)]));
  const schema: SchemaModel = { dialect: "postgres", tables: [...models.values()], source: "synthetic" };
  for (const t of tabs) {
    const tm = models.get(t)!;
    const emitted = writeCode(t, tabs);
    const files: CodeFile[] = emitted ? [{ file: emitted.file, text: emitted.text }] : [];
    if (!emitted && chance(0.08)) {
      // Code for a different table: it must not produce rules here.
      const other = tabs.find((x) => x !== t && x.code.length);
      if (other) {
        const e = writeCode(other, tabs);
        if (e) files.push({ file: e.file, text: e.text });
      }
    }
    const blocks = files.length ? codeContext(tm, files) : [];
    const codeText = blocks.map((b) => b.text).join("\n");
    const fromCode = emitted ? emitted.rules.filter((r) => blocks.length && codeMentions(codeText, t, r.column)) : [];
    const gold = [...t.gold, ...fromCode];
    if (!askable(schema, tm, blocks.length ? codeText : undefined) && gold.length === 0) continue;
    if (!askable(schema, tm, blocks.length ? codeText : undefined)) throw new Error(`gold rules on a table the CLI would not ask about: ${t.name}: ${answerText(gold)}
${tablePrompt(schema, tm, blocks)}`);
    const user = tablePrompt(schema, tm, blocks);
    out.push({ id: `s${n}.${t.name}`, table: tm.name, user, prompt: chatPrompt(user), answer: answerText(gold), code: blocks.length > 0, kinds: [...new Set(gold.map((g) => g.kind))] });
  }
}

function codeMentions(text: string, t: Tab, column: string): boolean {
  const f = t.fields.find((x) => x.name === column);
  if (!f) return false;
  const variants = [f.name, words(f.base).join("_"), camel(f.base), pascal(f.base)];
  return variants.some((v) => new RegExp(`\\b${v}\\b`).test(text));
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out.map((e) => JSON.stringify(e)).join("\n") + "\n");
const kinds = new Map<string, number>();
for (const e of out) for (const k of e.kinds.length ? e.kinds : ["none"]) kinds.set(k, (kinds.get(k) ?? 0) + 1);
console.log(`${out.length} examples from ${SCHEMAS} schemas → ${OUT}`);
console.log(`with code: ${out.filter((e) => e.code).length}; by kind: ${[...kinds].map(([k, v]) => `${k} ${v}`).join(", ")}`);
