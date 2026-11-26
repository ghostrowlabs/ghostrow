/**
 * Failing test names from a test runner's output. Understands Vitest, Jest, Mocha, Node's
 * test runner, pytest, Go, RSpec, PHPUnit, Cargo and JUnit-style output; if none match but
 * the command failed, the whole command counts as one failing test.
 */
export function failedTests(output: string, exitCode: number): string[] {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const found = new Set<string>();
  const add = (s: string | undefined) => {
    const t = s?.trim().replace(/\s+\d+(\.\d+)?\s*m?s$/, "");
    if (t && t.length < 300) found.add(t);
  };
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^\s*(?:FAIL|×|✗|✕|❯)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:>|›)\s*(.+)$/.exec(line))) add(`${m[1]} > ${m[2]}`); // vitest
    else if ((m = /^\s*●\s+(.+›.+)$/.exec(line))) add(m[1]); // jest
    else if ((m = /^\s*(?:×|✗|✕)\s+(.+)$/.exec(line))) add(m[1]); // vitest/jest list
    else if ((m = /^\s*FAILED\s+(\S+::\S+)/.exec(line))) add(m[1]); // pytest
    else if ((m = /^\s*--- FAIL:\s+(\S+)/.exec(line))) add(m[1]); // go
    else if ((m = /^rspec\s+(\.\/\S+:\d+)/.exec(line))) add(m[1]); // rspec
    else if ((m = /^\d+\)\s+([\w\\]+::\w+)/.exec(line))) add(m[1]); // phpunit
    else if ((m = /^test\s+(\S+)\s+\.\.\.\s+FAILED/.exec(line))) add(m[1]); // cargo
    else if ((m = /^not ok \d+ - (.+)$/.exec(line))) add(m[1]); // TAP / node --test
    else if ((m = /^\s+\d+\)\s+(.+):$/.exec(line))) add(m[1]); // mocha
    else if ((m = /^\s*(?:FAIL|FAILED)[:\s]+(\S+\.(?:spec|test)\.\S+:\d+)/.exec(line))) add(m[1]); // file:line style
  }
  if (found.size === 0 && exitCode !== 0) found.add(`test command (exit ${exitCode})`);
  return [...found].sort();
}
