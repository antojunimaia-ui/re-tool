// Standardized re-tool errors.

/**
 * re-tool domain error. The CLI catches it, prints the message, and exits
 * with `exitCode` (default 1).
 */
export class ToolError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ToolError";
    this.exitCode = exitCode;
  }
}
