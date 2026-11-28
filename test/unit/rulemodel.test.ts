import { describe, expect, it } from "vitest";
import { parseDDL } from "../../src/connect/ddl.js";
import type { SchemaModel } from "../../src/connect/types.js";
import { detectChecks, detectFk, detectUnique } from "../../src/engine/rules.js";
const declared = (s: SchemaModel) => [...detectFk(s), ...detectUnique(s), ...detectChecks(s)];
import { codeContext } from "../../src/rulemodel/code.js";
import { answerText, askable, checkProposal, parseLine, proposalKey, tablePrompt } from "../../src/rulemodel/format.js";

const schema: SchemaModel = {
  dialect: "postgres",
  source: "test",
  tables: parseDDL(`
    CREATE TABLE products (id serial PRIMARY KEY, name text NOT NULL, price numeric(10,2) NOT NULL);
    CREATE TABLE orders (id serial PRIMARY KEY, placed_at timestamp NOT NULL, shipped_at timestamp, total numeric(10,2) NOT NULL, currency char(3) NOT NULL, CHECK (total >= 0));
    CREATE TABLE order_lines (id serial PRIMARY KEY, order_id int NOT NULL REFERENCES orders(id), product_id int NOT NULL REFERENCES products(id),
      quantity int NOT NULL, unit_price numeric(10,2) NOT NULL, amount numeric(10,2) NOT NULL, note varchar(40), currency char(3));
  `),
};
const t = (name: string) => schema.tables.find((x) => x.name === name)!;
const check = (table: string, line: string, fromCode = false) => checkProposal(schema, t(table), parseLine(line)!, declared(schema), "test", fromCode);

describe("rule format", () => {
  it("reads every rule kind and nothing else", () => {
    expect(parseLine("order placed_at <= shipped_at")).toEqual({ kind: "order", earlier: "placed_at", later: "shipped_at", strict: false });
    expect(parseLine("sum total = order_lines.amount")).toEqual({ kind: "sum", column: "total", childTable: "order_lines", childColumn: "amount" });
    expect(parseLine("product amount = quantity * unit_price")?.kind).toBe("product");
    expect(parseLine("copy unit_price = products.price")?.kind).toBe("copy");
    expect(parseLine("min quantity 1")).toEqual({ kind: "min", column: "quantity", value: 1 });
    expect(parseLine("values status draft|sent")).toEqual({ kind: "values", column: "status", values: ["draft", "sent"] });
    for (const bad of ["order a = b", "sum len(x) = y", "copy x = y", "maxlen x -1", "drop table orders", ""]) expect(parseLine(bad)).toBeNull();
  });

  it("writes answers in a stable order, none when empty", () => {
    expect(answerText([])).toBe("none");
    expect(answerText([parseLine("min quantity 1")!, parseLine("order a <= b")!, parseLine("order a <= b")!])).toBe("order a <= b\nmin quantity 1");
  });

  it("builds the prompt from schema text: the table, its parents and children", () => {
    const p = tablePrompt(schema, t("order_lines"));
    expect(p).toContain("table order_lines");
    expect(p).toContain("order_id integer -> orders");
    expect(p).toMatch(/^parent orders \(order_id\):/m);
    expect(tablePrompt(schema, t("orders"))).toMatch(/^child order_lines \(order_id\):/m);
    expect(askable(schema, t("products"))).toBe(true);
  });
});

describe("the deterministic check", () => {
  it("accepts rules whose columns, types and keys fit", () => {
    for (const [table, line] of [
      ["orders", "order placed_at <= shipped_at"],
      ["orders", "sum total = order_lines.amount"],
      ["order_lines", "product amount = quantity * unit_price"],
      ["order_lines", "copy unit_price = products.price"],
      ["order_lines", "copy currency = orders.currency"],
    ] as const) {
      const v = check(table, line);
      expect(v.ok, `${table}: ${line}`).toBe(true);
    }
    const v = check("order_lines", "sum total = order_lines.amount");
    expect(v.ok).toBe(false);
  });

  it("rejects proposals that name missing columns, wrong types or no relation", () => {
    const reasons = (table: string, line: string, code = false) => {
      const v = check(table, line, code);
      return v.ok ? "accepted" : v.reason;
    };
    expect(reasons("orders", "order placed_at <= shipped_on")).toMatch(/no column/);
    expect(reasons("orders", "order placed_at <= currency")).toMatch(/can't be compared/);
    expect(reasons("products", "sum price = orders.total")).toMatch(/doesn't reference|references/);
    expect(reasons("order_lines", "copy unit_price = orders.total")).toBe("accepted");
    expect(reasons("order_lines", "product order_id = quantity * unit_price")).toMatch(/key/);
    expect(reasons("order_lines", "copy note = products.name")).toMatch(/longer|can't hold/);
    // Limits and allowed values only come from code that was read.
    expect(reasons("order_lines", "min quantity 1")).toMatch(/application code/);
    expect(reasons("order_lines", "min quantity 1", true)).toBe("accepted");
    expect(reasons("order_lines", "maxlen note 40", true)).toMatch(/already declared/);
    expect(reasons("orders", "min total 0", true)).toMatch(/already limits/);
  });

  it("refuses an ordering that contradicts or cycles with the plan", () => {
    const rules = declared(schema);
    const first = checkProposal(schema, t("orders"), parseLine("order placed_at <= shipped_at")!, rules, "t", false);
    expect(first.ok).toBe(true);
    if (first.ok) rules.push(first.rule);
    const back = checkProposal(schema, t("orders"), parseLine("order shipped_at <= placed_at")!, rules, "t", false);
    expect(back.ok).toBe(false);
  });

  it("compares proposals by meaning, not spelling", () => {
    expect(proposalKey("T", parseLine("product a = x * y")!)).toBe(proposalKey("t", parseLine("product A = Y * X")!));
    expect(proposalKey("t", parseLine("order a < b")!)).toBe(proposalKey("t", parseLine("order a <= b")!));
  });
});

describe("code context", () => {
  it("finds the code that names a table's columns, in any spelling", () => {
    const files = [
      { file: "src/order-line.ts", text: "export const OrderLine = z.object({\n  quantity: z.number().int().min(1),\n  unitPrice: z.number().nonnegative(),\n});" },
      { file: "src/user.ts", text: "export const User = z.object({ email: z.string().email() });" },
    ];
    const blocks = codeContext(t("order_lines"), files);
    expect(blocks.map((b) => b.file)).toEqual(["src/order-line.ts"]);
    expect(blocks[0]!.text).toContain("min(1)");
    expect(codeContext(t("products"), files)).toEqual([]);
  });

  it("keeps the constraint lines of a large file within the budget", () => {
    const doc = Array.from({ length: 200 }, (_, i) => ` * @property int $quantity note ${i} unit_price`).join("\n");
    const text = `${doc}\n    'quantity' => 'required|integer|min:1|max:99',\n    'unit_price' => 'numeric|min:0',`;
    const [b] = codeContext(t("order_lines"), [{ file: "LineItem.php", text }], 600);
    expect(b!.text.length).toBeLessThanOrEqual(600);
    expect(b!.text).toContain("min:1|max:99");
  });
});

describe("circular derivations", () => {
  it("won't sum a column that is copied from the total, or copy a total that sums it", () => {
    const rules = declared(schema);
    const copy = checkProposal(schema, t("order_lines"), parseLine("copy unit_price = products.price")!, rules, "t", false);
    expect(copy.ok).toBe(true);
    if (copy.ok) rules.push(copy.rule);
    const sum = checkProposal(schema, t("products"), parseLine("sum price = order_lines.unit_price")!, rules, "t", false);
    expect(sum.ok ? "accepted" : sum.reason).toMatch(/circular/);
  });
});

describe("limits against declared CHECKs", () => {
  it("keeps a stricter limit from code, drops one the schema already implies", () => {
    expect(check("orders", "min total 0", true).ok).toBe(false);
    expect(check("orders", "min total 1", true).ok).toBe(true);
  });
});
