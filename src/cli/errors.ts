/**
 * Exit codes as promised in content/docs/cli-reference.mdx:
 *   0 success · 1 invalid input/config · 2 constraint unsatisfiable ·
 *   3 haunt --tests found failures · 4 license problem.
 */
export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_CONSTRAINT = 2;
export const EXIT_HAUNT = 3;
export const EXIT_LICENSE = 4;

type Kind = "invalid" | "constraint" | "haunt" | "license";

const EXIT: Record<Kind, number> = { invalid: EXIT_INVALID, constraint: EXIT_CONSTRAINT, haunt: EXIT_HAUNT, license: EXIT_LICENSE };

export class GhostrowError extends Error {
  readonly exitCode: number;
  readonly kind: Kind;
  readonly hint?: string;

  constructor(kind: Kind, message: string, hint?: string) {
    super(message);
    this.name = "GhostrowError";
    this.kind = kind;
    this.hint = hint;
    this.exitCode = EXIT[kind];
  }
}

/** Invalid input or configuration → exit 1. */
export function invalidInput(message: string, hint?: string): GhostrowError {
  return new GhostrowError("invalid", message, hint);
}

/** A constraint could not be satisfied → exit 2. */
export function constraintUnsatisfied(message: string, hint?: string): GhostrowError {
  return new GhostrowError("constraint", message, hint);
}

/** haunt --tests found failing tests → exit 3. */
export function hauntFoundFailures(message: string, hint?: string): GhostrowError {
  return new GhostrowError("haunt", message, hint);
}

/** License problem (not activated, limit reached, expired activation) → exit 4. */
export function licenseProblem(message: string, hint?: string): GhostrowError {
  return new GhostrowError("license", message, hint);
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof GhostrowError) return err.exitCode;
  return EXIT_INVALID;
}
