// Failure taxonomy for `occ`. The exit code is part of the CLI's contract for
// scripts, so it lives next to the error types rather than in the printer.
//
// A message is written for a human reading a terminal. That is not enough for
// anything that has to *act* on a failure — a supervisor deciding whether to
// retry, a script branching on a cause, an agent choosing what to change. Those
// need the same information the human gets, minus the prose.
//
// So a failure carries four fields:
//
//   code   stable identifier, safe to branch on; never a sentence
//   step   which pipeline stage failed, for a caller assembling a report
//   cause  what actually went wrong, which is often not where it surfaced
//   hint   the next thing to try
//
// `cause` exists because the most expensive failures are the ones that surface
// somewhere else: a relative output path made an ffprobe call fail, and the
// error said "audio". Naming the cause is the difference between three rounds of
// debugging and one line of advice.

export interface FailureDetail {
  /** Stable, greppable identifier. Branch on this, not on the message. */
  code: string;
  /** Pipeline stage, e.g. `render`, `footage`, `qc`. */
  step?: string;
  /** What actually went wrong. Omit when the message already says it. */
  cause?: string;
  /** The next thing to try. */
  hint?: string;
}

/** Expected failure with a message written for a human: one line, exit 1. */
export class CliError extends Error {
  readonly detail?: FailureDetail;

  constructor(message: string, detail?: FailureDetail) {
    super(message);
    this.name = 'CliError';
    this.detail = detail;
  }
}

/** Bad invocation (unknown flag or command, missing argument): usage, exit 2. */
export class UsageError extends CliError {
  constructor(message: string, detail?: FailureDetail) {
    super(message, detail);
    this.name = 'UsageError';
  }
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** The shape printed by `--json` when a command fails. */
export interface FailureEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    step?: string;
    cause?: string;
    hint?: string;
  };
}

export function failureEnvelope(error: unknown, fallbackStep?: string): FailureEnvelope {
  if (error instanceof CliError) {
    const detail = error.detail;
    const step = detail?.step ?? fallbackStep;
    return {
      ok: false,
      error: {
        code: detail?.code ?? (error instanceof UsageError ? 'usage' : 'cli-error'),
        message: error.message,
        ...(step ? { step } : {}),
        ...(detail?.cause ? { cause: detail.cause } : {}),
        ...(detail?.hint ? { hint: detail.hint } : {}),
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code: error instanceof Error && error.name === 'ExternalEditorCallError'
        ? 'external-editor-failed'
        : 'unexpected',
      message,
      ...(fallbackStep ? { step: fallbackStep } : {}),
      hint: 'Not a known failure — read the stack trace and the last file it touched.',
    },
  };
}

/** Human-readable lines: the message, then cause and hint if they add anything. */
export function failureLines(error: unknown): string[] {
  const { error: detail } = failureEnvelope(error);
  const lines = [detail.message];
  if (detail.cause) lines.push(`  cause: ${detail.cause}`);
  if (detail.hint) lines.push(`  hint:  ${detail.hint}`);
  return lines;
}
