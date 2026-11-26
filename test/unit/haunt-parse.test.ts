import { describe, expect, it } from "vitest";
import { failedTests } from "../../src/haunt/parse.js";

describe("failedTests", () => {
  it("returns an empty list on success", () => {
    expect(failedTests("Tests  12 passed (12)\n", 0)).toEqual([]);
    expect(failedTests("", 0)).toEqual([]);
  });

  it("returns an empty list when exit is 0 even if the output mentions FAIL words with no test shape", () => {
    expect(failedTests("all good, nothing FAILED here", 0)).toEqual([]);
  });

  it("parses Vitest failures", () => {
    const out = [
      " FAIL  src/orders.test.ts > orders > rejects negative totals",
      "AssertionError: expected 1 to be 2",
      " FAIL  src/users.spec.ts > users > requires email",
    ].join("\n");
    expect(failedTests(out, 1)).toEqual(["src/orders.test.ts > orders > rejects negative totals", "src/users.spec.ts > users > requires email"]);
  });

  it("parses Vitest list markers", () => {
    const out = "   × rejects bad input 3ms\n   ✓ passes 2ms\n";
    expect(failedTests(out, 1)).toEqual(["rejects bad input"]);
  });

  it("parses Jest bullets", () => {
    const out = ["FAIL src/cart.test.js", "  ● Cart › adds an item", "", "    expect(received).toBe(expected)", "  ● Cart › removes an item"].join("\n");
    expect(failedTests(out, 1)).toEqual(["Cart › adds an item", "Cart › removes an item"]);
  });

  it("parses pytest FAILED lines", () => {
    const out = ["=========== short test summary info ===========", "FAILED tests/test_x.py::test_y - assert 1 == 2", "FAILED tests/test_x.py::TestK::test_z", "1 failed"].join("\n");
    expect(failedTests(out, 1)).toEqual(["tests/test_x.py::TestK::test_z", "tests/test_x.py::test_y"]);
  });

  it("parses Go failures and strips the duration", () => {
    const out = "--- FAIL: TestX (0.01s)\n    x_test.go:10: boom\n--- FAIL: TestY/sub (0.00s)\nFAIL\n";
    expect(failedTests(out, 1)).toEqual(["TestX", "TestY/sub"]);
  });

  it("parses PHPUnit numbered failures", () => {
    const out = "There was 1 failure:\n\n1) Tests\\Feature\\OrderTest::testTotals\nFailed asserting that 1 matches 2.\n";
    expect(failedTests(out, 1)).toEqual(["Tests\\Feature\\OrderTest::testTotals"]);
  });

  it("parses RSpec rerun lines", () => {
    const out = "Failed examples:\n\nrspec ./spec/models/order_spec.rb:12 # Order totals sums lines\n";
    expect(failedTests(out, 1)).toEqual(["./spec/models/order_spec.rb:12"]);
  });

  it("parses Cargo failures", () => {
    const out = "test orders::tests::adds ... ok\ntest orders::tests::subtracts ... FAILED\n\nfailures:\n";
    expect(failedTests(out, 101)).toEqual(["orders::tests::subtracts"]);
  });

  it("parses TAP and node --test output", () => {
    const out = "TAP version 13\nok 1 - fine\nnot ok 3 - totals are positive\n  ---\n  duration_ms: 1\n";
    expect(failedTests(out, 1)).toEqual(["totals are positive"]);
  });

  it("parses Mocha numbered failures", () => {
    const out = "  2 failing\n\n  1) Orders adds an item:\n     AssertionError\n  2) Orders removes an item:\n     AssertionError\n";
    expect(failedTests(out, 1)).toEqual(["Orders adds an item", "Orders removes an item"]);
  });

  it("strips ANSI colour codes", () => {
    const out = "\u001b[31m FAIL \u001b[39m src/a.test.ts > a > b\n";
    const res = failedTests(out, 1);
    expect(res).toEqual(["src/a.test.ts > a > b"]);
    expect(res[0]).not.toContain("\u001b");
  });

  it("de-duplicates and sorts", () => {
    const out = "FAILED tests/b.py::t2\nFAILED tests/a.py::t1\nFAILED tests/b.py::t2\n";
    expect(failedTests(out, 1)).toEqual(["tests/a.py::t1", "tests/b.py::t2"]);
  });

  it("falls back to the command when nothing parses and the exit code is non-zero", () => {
    expect(failedTests("something exploded\n", 2)).toEqual(["test command (exit 2)"]);
    expect(failedTests("", 137)).toEqual(["test command (exit 137)"]);
  });

  it("does not use the fallback when tests were parsed", () => {
    expect(failedTests("FAILED tests/a.py::t1\n", 1)).toEqual(["tests/a.py::t1"]);
  });
});

describe("failedTests: JUnit", () => {
  it("parses JUnit XML printed to the output", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="orders" tests="3" failures="1" errors="1">
  <testcase classname="OrdersTest" name="rejects negative totals" time="0.01"><failure message="expected">stack</failure></testcase>
  <testcase classname="OrdersTest" name="accepts &quot;zero&quot;" time="0.01"/>
  <testcase classname="UsersTest" name="requires email" time="0.02">
    <error type="NullPointerException">boom</error>
  </testcase>
  <testcase classname="UsersTest" name="skipped one"><skipped/></testcase>
</testsuite></testsuites>`;
    expect(failedTests(xml, 1)).toEqual(["OrdersTest > rejects negative totals", "UsersTest > requires email"]);
  });

  it("unescapes XML entities in names", () => {
    const xml = `<testcase classname="a.B" name="x &lt; y &amp;&amp; z"><failure/></testcase>`;
    expect(failedTests(xml, 1)).toEqual(["a.B > x < y && z"]);
  });

  it("parses Maven Surefire console failures", () => {
    const out = [
      "[ERROR] Tests run: 3, Failures: 1, Errors: 1, Skipped: 0",
      "[ERROR] Failures: ",
      "[ERROR]   com.shop.OrdersTest.rejectsNegative:42 expected: <1> but was: <2>",
      "[ERROR] Errors: ",
      "[ERROR]   com.shop.UsersTest.requiresEmail » NullPointer",
      "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test",
    ].join("\n");
    expect(failedTests(out, 1)).toEqual(["com.shop.OrdersTest.rejectsNegative", "com.shop.UsersTest.requiresEmail"]);
  });

  it("parses Gradle test failures", () => {
    const out = "OrdersTest > rejectsNegative() FAILED\n    org.opentest4j.AssertionFailedError at OrdersTest.java:42\n";
    expect(failedTests(out, 1)).toEqual(["OrdersTest > rejectsNegative()"]);
  });
});
