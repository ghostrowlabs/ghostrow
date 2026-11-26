/**
 * Failing test names from a test runner's output. Understands Vitest, Jest, Mocha, Node's
 * test runner, pytest, Go, RSpec, PHPUnit, Cargo, Maven Surefire and Gradle console output,
 * and JUnit XML printed to the output (for example `vitest --reporter=junit` or
 * `jest --reporters=jest-junit` writing to stdout; report files on disk aren't read).
 * If none match but the command failed, the whole command counts as one failing test.
 */
export function failedTests(output: string, exitCode: number): string[] {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const found = new Set<string>();
  const add = (s: string | undefined) => {
    const t = s?.trim().replace(/\s+\d+(\.\d+)?\s*m?s$/, "");
    if (t && t.length < 300) found.add(t);
  };
  for (const name of junitXmlFailures(text)) add(name);
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^\s*(?:FAIL|×|✗|✕|❯)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:>|›)\s*(.+)$/.exec(line))) add(`${m[1]} > ${m[2]}`); // vitest
    else if ((m = /^\s*●\s+(.+›.+)$/.exec(line))) add(m[1]); // jest
    else if ((m = /^\s*(?:×|✗|✕|✘)\s+(.+)$/.exec(line))) add(m[1]); // vitest/jest list, JUnit 5 console launcher
    else if ((m = /^\s*FAILED\s+(\S+::\S+)/.exec(line))) add(m[1]); // pytest
    else if ((m = /^\s*--- FAIL:\s+(\S+)/.exec(line))) add(m[1]); // go
    else if ((m = /^rspec\s+(\.\/\S+:\d+)/.exec(line))) add(m[1]); // rspec
    else if ((m = /^\d+\)\s+([\w\\]+::\w+)/.exec(line))) add(m[1]); // phpunit
    else if ((m = /^test\s+(\S+)\s+\.\.\.\s+FAILED/.exec(line))) add(m[1]); // cargo
    else if ((m = /^not ok \d+ - (.+)$/.exec(line))) add(m[1]); // TAP / node --test
    else if ((m = /^\s+\d+\)\s+(.+):$/.exec(line))) add(m[1]); // mocha
    else if ((m = /^\[ERROR\]\s+([\w$]+(?:\.[\w$]+)*\.[\w$]+)(?::\d+|\s+»)/.exec(line))) add(m[1]); // maven surefire (JUnit)
    else if ((m = /^(\S+)\s+>\s+(.+?)\s+FAILED$/.exec(line))) add(`${m[1]} > ${m[2]}`); // gradle (JUnit)
    else if ((m = /^\s*(?:FAIL|FAILED)[:\s]+(\S+\.(?:spec|test)\.\S+:\d+)/.exec(line))) add(m[1]); // file:line style
  }
  if (found.size === 0 && exitCode !== 0) found.add(`test command (exit ${exitCode})`);
  return [...found].sort();
}

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k === "amp") return "&";
    return String.fromCodePoint(k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? unescapeXml(m[1] ?? m[2] ?? "") : undefined;
}

/** `<testcase>` elements that contain a `<failure>` or `<error>`, as "classname > name". */
export function junitXmlFailures(text: string): string[] {
  if (!text.includes("<testcase")) return [];
  const out: string[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[3];
    if (!body || !/<(?:failure|error)\b/.test(body)) continue;
    const name = attr(m[1]!, "name");
    if (!name) continue;
    const cls = attr(m[1]!, "classname");
    out.push(cls && cls !== name ? `${cls} > ${name}` : name);
  }
  return out;
}
