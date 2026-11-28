import { Command } from "commander";
import { VERSION } from "../version.js";
import { parseSeed, type RunContext } from "./context.js";
import { exitCodeFor, GhostrowError, invalidInput } from "./errors.js";
import {
  activateHandler,
  buildHauntOptions,
  buildSeedOptions,
  buildTwinOptions,
  deactivateHandler,
  hauntHandler,
  seedHandler,
  statusHandler,
  twinHandler,
} from "./handlers.js";
import { runModelPull, runModelRemove, runModelStatus } from "../model/cli.js";

export interface ProgramResult {
  code: number;
}

/** Builds the command tree exactly as content/docs/cli-reference.mdx promises. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ghostrow")
    .description("Real-looking data. Zero real data.")
    .version(VERSION, "-v, --version", "Print the version.")
    .addHelpText(
      "after",
      [
        "",
        "Your own AI provider (Pro, Max; off unless set; sends schema text only, never rows):",
        "  GHOSTROW_AI_PROVIDER  anthropic | openai | gemini | bedrock | vertex | azure",
        "  GHOSTROW_AI_MODEL     model to use (on Azure: the deployment name)",
        "  anthropic  ANTHROPIC_API_KEY      openai  OPENAI_API_KEY      gemini  GEMINI_API_KEY",
        "  bedrock    AWS_REGION; AWS credentials (env, AWS_PROFILE, SSO, instance role) or AWS_BEARER_TOKEN_BEDROCK",
        "  vertex     GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION (default global); gcloud ADC or GOOGLE_OAUTH_ACCESS_TOKEN",
        "  azure      AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_KEY (or AZURE_OPENAI_AD_TOKEN)",
        "  Details: https://ghostrow.com/docs/ai-providers",
      ].join("\n"),
    );

  program
    .option("--db <url>", "Connect to a database (Postgres, MySQL, SQLite or SQL Server URL)")
    .option("--schema <file>", "Read a schema file or ORM models instead of a live database")
    .option("--code <dir>", "Also read application code for validation rules (Pro and Max)")
    .option("--rules <file>", "Rules file to read and update", "ghostrow.rules.yaml")
    .option("--seed <n>", "Random seed. The same seed gives the same output")
    .option("--no-model", "Don't use the installed on-device models for this run (rule engine only)")
    .option("-q, --quiet", "Less output")
    .option("--json", "Machine-readable output");

  const seed = program.command("seed").description("Generate consistent, realistic data.");
  seed
    .option("--rows <n>", "Rows for the largest table; others scale with their relations")
    .option("-t, --table <name=n>", "Rows for a specific table. Repeat for more tables", (value: string, prev?: string[]) => [...(prev ?? []), value])
    .option("--out <dir>", "Write files instead of inserting")
    .option("-f, --format <csv|sql|json>", "File format for --out", "csv")
    .option("--dry-run", "Show inferred meanings and rules without writing rows");
  seed.action(async (_o: object, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    return seedHandler(resolveContext(globals), buildSeedOptions(globals));
  });

  const haunt = program.command("haunt").description("Generate edge-case rows; with --tests, report which rows broke which tests. (Pro, Max)");
  haunt
    .option("--tests <cmd>", "Test command to run, for example \"npm test\"")
    .option("--cases <n>", "Maximum number of edge-case rows", "300")
    .option("--report <file>", "Where to write the report", "haunt-report.json");
  haunt.action(async (_o: object, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    return hauntHandler(resolveContext(globals), buildHauntOptions(globals));
  });

  const twin = program.command("twin").description("Generate a synthetic copy with the same shape as a database. (Max)");
  twin
    .option("--from <url>", "Database to measure (read-only access is enough)")
    .option("--to <url>", "Where to write the synthetic copy")
    .option("--out <dir>", "Write files instead of inserting")
    .option("--scale <factor>", "Make the copy larger or smaller, for example 0.1")
    .option("-f, --format <csv|sql|json>", "File format for --out", "csv");
  twin.action(async (_o: object, cmd: Command) => {
    const globals = cmd.optsWithGlobals();
    return twinHandler(resolveContext(globals), buildTwinOptions(globals));
  });

  const model = program.command("model").description("Download and manage the on-device models (all plans)");
  model
    .command("pull [name]")
    .description("Download a model and verify its signature: gr-col-1 (default, column meanings) or gr-rules-1 (rules between columns and from code)")
    .action((name: string | undefined, _o: object, cmd: Command) => runModelPull(resolveContext(cmd.optsWithGlobals()), name));
  model
    .command("status")
    .description("Show the installed models")
    .action((_o: object, cmd: Command) => runModelStatus(resolveContext(cmd.optsWithGlobals())));
  model
    .command("remove [name]")
    .description("Delete an installed model (default gr-col-1)")
    .action((name: string | undefined, _o: object, cmd: Command) => runModelRemove(resolveContext(cmd.optsWithGlobals()), name));

  program
    .command("activate <key>")
    .description("Activate this machine for your license")
    .action((key: string, _o: object, cmd: Command) => activateHandler(resolveContext(cmd.optsWithGlobals()), key));
  program
    .command("deactivate")
    .description("Free this machine so you can use the seat elsewhere")
    .action((_o: object, cmd: Command) => deactivateHandler(resolveContext(cmd.optsWithGlobals())));
  program
    .command("status")
    .description("Show the plan, seat, machines used and updates end date")
    .action((_o: object, cmd: Command) => statusHandler(resolveContext(cmd.optsWithGlobals())));

  return program;
}

function resolveContext(globals: Record<string, unknown>): RunContext {
  let seedValue: number | undefined;
  if (typeof globals.seed === "string") {
    try {
      seedValue = parseSeed(globals.seed, "--seed");
    } catch (e) {
      throw invalidInput(e instanceof Error ? e.message : String(e));
    }
  }
  return {
    db: typeof globals.db === "string" ? globals.db : undefined,
    schema: typeof globals.schema === "string" ? globals.schema : undefined,
    codeDir: typeof globals.code === "string" ? globals.code : undefined,
    rules: typeof globals.rules === "string" ? globals.rules : "ghostrow.rules.yaml",
    seed: seedValue,
    quiet: Boolean(globals.quiet),
    json: Boolean(globals.json),
    noModel: globals.model === false,
  };
}

export async function run(argv: string[]): Promise<ProgramResult> {
  const program = buildProgram();
  program.exitOverride();
  // Bare `ghostrow` (no command, no flags): help on stdout, exit 0. Package validators (winget) run it this way.
  if (argv.slice(2).length === 0) {
    process.stdout.write(program.helpInformation());
    return { code: 0 };
  }
  let code = 0;
  try {
    await program.parseAsync(argv, { from: "node" });
  } catch (err) {
    if (err instanceof GhostrowError) {
      code = exitCodeFor(err);
      process.stderr.write(`ghostrow: ${err.message}\n`);
      if (err.hint) process.stderr.write(`  ${err.hint}\n`);
    } else {
      const anyErr = err as { exitCode?: number; code?: string };
      if (!anyErr.code?.startsWith("commander.") && err instanceof Error) {
        process.stderr.write(`ghostrow: ${err.message}
`);
        if (process.env.GHOSTROW_DEBUG && err.stack) process.stderr.write(`${err.stack}
`);
        return { code: 1 };
      }
      // commander help/version exit with code 0; real parse errors exit with 1.
      code = anyErr.code === "commander.helpDisplayed" || anyErr.code === "commander.version" ? 0 : 1;
      if (code === 1 && err instanceof Error) process.stderr.write(`ghostrow: ${err.message}\n`);
    }
  }
  return { code };
}
