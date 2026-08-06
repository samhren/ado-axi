import { execFile } from "node:child_process";
import { AxiError, azNotInstalledError, mapAzError, type AzErrorContext } from "./errors.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const NON_INTERACTIVE_FLAGS = ["--only-show-errors"];

/**
 * The Azure CLI is a Python program. When its stdout is a pipe, Python picks an
 * encoding from the machine locale - on Windows that is usually cp1252, and a
 * single non-ASCII byte in an Azure DevOps response (an em dash in a PR
 * description, an infinity sign in a review comment) makes it die with a
 * `charmap` UnicodeEncodeError before we ever see the JSON. Forcing UTF-8 in the
 * child process removes that failure mode on every platform.
 */
function utf8ChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

/** Decode a child-process chunk as UTF-8 regardless of the platform code page, dropping any BOM. */
export function decodeUtf8(chunk: string | Buffer | undefined | null): string {
  if (chunk === undefined || chunk === null) return "";
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toExecResult(
  resolve: (result: ExecResult) => void,
): (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void {
  return (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
      return;
    }
    const exitCode = error
      ? ((error as Error & { code?: string | number }).code ?? 1)
      : 0;
    resolve({
      stdout: decodeUtf8(stdout),
      stderr: decodeUtf8(stderr),
      exitCode: typeof exitCode === "number" ? exitCode : 1,
    });
  };
}

function run(args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      "az",
      [...args, "--output", "json", ...NON_INTERACTIVE_FLAGS],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "buffer", env: utf8ChildEnv() },
      toExecResult(resolve),
    );
  });
}

/**
 * Execute az and return parsed JSON.
 *
 * `context` describes the caller (operation, command category, endpoint) so a
 * failure surfaces an actionable error instead of a bare stderr line.
 */
export async function azJson<T = unknown>(
  args: string[],
  context?: AzErrorContext,
): Promise<T> {
  const result = await run(args);
  if (result.stderr === "ENOENT") throw azNotInstalledError();
  if (result.exitCode !== 0) {
    throw mapAzError(result.stderr, result.exitCode, {
      category: `az ${describeAzCommand(args)}`,
      ...context,
    });
  }
  if (result.stdout.trim().length === 0) {
    return null as T;
  }
  return parseAzJson<T>(result.stdout, args, context);
}

/** Parse az stdout as JSON, naming the command that produced a non-JSON payload. */
export function parseAzJson<T>(
  stdout: string,
  args: string[],
  context?: AzErrorContext,
): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const prefix = context?.operation ? `${context.operation}: ` : "";
    throw new AxiError(
      `${prefix}unexpected non-JSON output from \`az ${describeAzCommand(args)}\`: ${stdout.slice(0, 200)}`,
      "UNKNOWN",
      ["Re-run the same command with `az` directly to inspect its raw output"],
    );
  }
}

/** Execute az, returning stdout + stderr without throwing on non-zero exit. */
export async function azRaw(args: string[]): Promise<ExecResult> {
  const result = await run(args);
  if (result.stderr === "ENOENT") throw azNotInstalledError();
  return result;
}

/** The leading non-flag words of an az argv - e.g. "repos pr show" - used to label errors. */
export function describeAzCommand(args: string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  return words.join(" ");
}
