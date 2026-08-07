import { AxiError } from "axi-sdk-js";

export type ErrorCode =
  | "NOT_FOUND"
  | "AUTH_REQUIRED"
  | "ORG_NOT_CONFIGURED"
  | "PROJECT_NOT_CONFIGURED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "AZ_NOT_INSTALLED"
  | "DEVOPS_EXTENSION_MISSING"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "UNKNOWN";

export { AxiError };

/**
 * What the CLI was doing when a call failed. Every field is optional; the more of
 * it a caller supplies, the more actionable the rendered error is.
 */
export interface AzErrorContext {
  /** The user-facing operation, e.g. "pr inspect" or "pr update". */
  operation?: string;
  /** The command family or REST area, e.g. "az repos pr show" or "rest git/pullRequestThreads". */
  category?: string;
  /** The concrete endpoint or command that failed. */
  endpoint?: string;
  /** The `ado-axi` command worth running next. */
  nextCommand?: string;
}

/** Machine-readable specifics attached to a failure, rendered alongside the message. */
export interface AzErrorDetails extends AzErrorContext {
  /** HTTP status parsed out of the Azure response, when there was one. */
  status?: number;
  /** The az process exit code, when the failure came from a child process. */
  exitCode?: number;
  /** The message Azure itself returned, before any rewording. */
  azureMessage?: string;
}

/** An AxiError carrying structured operation details for rendering. */
export class AdoError extends AxiError {
  readonly details: AzErrorDetails;

  constructor(
    message: string,
    code: ErrorCode | string,
    suggestions: string[] = [],
    details: AzErrorDetails = {},
  ) {
    super(message, code, suggestions);
    this.details = details;
  }
}

/** Usage errors (bad or missing input the caller can fix without retrying) exit 2, everything else exits 1. */
const USAGE_ERROR_CODES: ReadonlySet<string> = new Set([
  "VALIDATION_ERROR",
  "ORG_NOT_CONFIGURED",
  "PROJECT_NOT_CONFIGURED",
]);

export function exitCodeForError(error: unknown): number {
  if (error instanceof AxiError && USAGE_ERROR_CODES.has(error.code)) {
    return 2;
  }
  return 1;
}

interface ErrorPattern {
  pattern: RegExp;
  code: ErrorCode;
  message: (match: RegExpMatchArray, stderr: string) => string;
  suggestions?: (match: RegExpMatchArray) => string[];
}

const patterns: ErrorPattern[] = [
  {
    pattern: /--organization must be specified/i,
    code: "ORG_NOT_CONFIGURED",
    message: () => "No Azure DevOps organization configured",
    suggestions: () => [
      "Pass --org https://dev.azure.com/<org>/",
      "Or run `az devops configure -d organization=https://dev.azure.com/<org>/` to set a default",
    ],
  },
  {
    pattern: /--project must be specified/i,
    code: "PROJECT_NOT_CONFIGURED",
    message: () => "No Azure DevOps project configured",
    suggestions: () => [
      "Pass --project <name-or-id>",
      "Or run `az devops configure -d project=<name>` to set a default",
    ],
  },
  {
    pattern: /unrecognized arguments:\s*(.+)/i,
    code: "VALIDATION_ERROR",
    message: (m) => `az rejected an argument this command does not accept: ${m[1].trim()}`,
    suggestions: () => [
      "This is an ado-axi bug - the flag should not have been forwarded to az",
      "Report it at https://github.com/samhren/ado-axi/issues",
    ],
  },
  {
    // `az devops invoke` pre-parses --api-version by stripping `-preview` and
    // calling float() on the rest, so `7.1-preview.1` reduces to `7.1.1` and
    // raises before the request is ever sent. See src/api/rest.ts.
    pattern: /could not convert string to float:\s*'([^']*)'/i,
    code: "VALIDATION_ERROR",
    message: (m) =>
      `az devops invoke could not parse the requested --api-version (it reduced to '${m[1]}', which is not a number)`,
    suggestions: () => [
      "Use a stable api-version such as `7.1`, or a bare `7.1-preview`",
      "A resource-version suffix (`7.1-preview.1`) cannot be used with `az devops invoke`",
    ],
  },
  {
    pattern: /'charmap' codec can't encode|UnicodeEncodeError|UnicodeDecodeError/i,
    code: "UNKNOWN",
    message: () =>
      "The Azure CLI could not encode a non-ASCII character in its response (its console code page is not UTF-8)",
    suggestions: () => [
      "ado-axi forces UTF-8 for every az call - if you still hit this, please report it",
      "As a workaround, set PYTHONUTF8=1 and PYTHONIOENCODING=utf-8 in your environment",
    ],
  },
  {
    pattern: /need to run the login command|Please run 'az login'|\(401\)|\bUnauthorized\b/i,
    code: "AUTH_REQUIRED",
    message: (_m, stderr) => firstErrorLine(stderr) || "Azure DevOps sign-in required",
    suggestions: () => [
      "Run `az login` if this organization uses an AAD/MSA identity",
      "Run `az devops login` if you authenticate with a personal access token",
    ],
  },
  {
    pattern: /TF400813|VS30063|not authorized to access|\(403\)|\bForbidden\b/i,
    code: "FORBIDDEN",
    message: (_m, stderr) =>
      firstErrorLine(stderr) || "Not authorized to access this Azure DevOps resource",
    // The identity is signed in, so `az login` will not help - do not suggest it.
    suggestions: () => [
      "You are signed in but lack permission on this organization, project, or repository",
      "Ask an Azure DevOps administrator for access, or re-issue your PAT with the required scopes",
    ],
  },
  {
    pattern: /work item (\d+) does not exist/i,
    code: "NOT_FOUND",
    message: (m) => `Work item #${m[1]} does not exist`,
    suggestions: () => [],
  },
  {
    pattern: /pull request (\d+) does not exist|no pull request found/i,
    code: "NOT_FOUND",
    message: (m) => `Pull request #${m[1] ?? ""} not found`.trim(),
    suggestions: () => ["Run `ado-axi pr list --status all` to see pull request ids"],
  },
  {
    pattern: /repository .* not found|TF401019/i,
    code: "NOT_FOUND",
    message: (_m, stderr) => firstErrorLine(stderr) || "Repository not found",
    suggestions: () => ["Run `ado-axi repo list` to see repositories"],
  },
  {
    pattern: /TF401232|VS403313|\(404\)|\bNot Found\b/i,
    code: "NOT_FOUND",
    message: (_m, stderr) => firstErrorLine(stderr) || "The requested item does not exist",
  },
  {
    pattern: /'([\w-]+)' is not in the '\w+' extension command tree|The command requires the extension/i,
    code: "DEVOPS_EXTENSION_MISSING",
    message: () => "The azure-devops CLI extension is not installed",
    suggestions: () => ["Run `az extension add --name azure-devops`"],
  },
  {
    pattern: /\(409\)|VS403309|\bConflict\b/i,
    code: "CONFLICT",
    message: (_m, stderr) =>
      firstErrorLine(stderr) || "The request conflicts with the current state of the resource",
  },
  {
    pattern: /\(429\)|too many requests|rate limit/i,
    code: "RATE_LIMITED",
    message: (_m, stderr) => firstErrorLine(stderr) || "Azure DevOps is rate limiting this client",
    suggestions: () => ["Wait a few seconds and retry"],
  },
  {
    pattern: /\(5\d\d\)|Internal Server Error|Service Unavailable/i,
    code: "SERVER_ERROR",
    message: (_m, stderr) => firstErrorLine(stderr) || "Azure DevOps returned a server error",
    suggestions: () => ["Retry - this is an Azure DevOps service-side failure"],
  },
];

function firstErrorLine(stderr: string): string {
  const cleaned = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("WARNING:"))[0];
  return (cleaned ?? "").replace(/^ERROR:\s*/, "");
}

/** Pull an HTTP status out of az stderr - az prints them as "(404)" or "status code: 404". */
export function parseHttpStatus(stderr: string): number | undefined {
  const match =
    stderr.match(/\((\d{3})\)/) ??
    stderr.match(/status(?: code)?[:\s]+(\d{3})/i) ??
    stderr.match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

/**
 * Turn az stderr into a structured error. With a `context` the message names the
 * operation and the command or endpoint that failed, so a caller never sees a
 * bare "unexpected error".
 */
export function mapAzError(
  stderr: string,
  exitCode: number,
  context: AzErrorContext = {},
): AdoError {
  const status = parseHttpStatus(stderr);
  const azureMessage = firstErrorLine(stderr);
  const details: AzErrorDetails = {
    ...context,
    ...(status !== undefined ? { status } : {}),
    exitCode,
    ...(azureMessage ? { azureMessage } : {}),
  };

  for (const { pattern, code, message, suggestions } of patterns) {
    const match = stderr.match(pattern);
    if (match) {
      return new AdoError(
        withOperation(message(match, stderr), context),
        code,
        withNextCommand(suggestions?.(match) ?? [], context),
        details,
      );
    }
  }

  if (/not found|does not exist/i.test(stderr)) {
    return new AdoError(
      withOperation(azureMessage, context),
      "NOT_FOUND",
      withNextCommand([], context),
      details,
    );
  }

  return new AdoError(
    withOperation(azureMessage || `az exited with code ${exitCode}`, context),
    "UNKNOWN",
    withNextCommand([], context),
    details,
  );
}

function withOperation(message: string, context: AzErrorContext): string {
  const where = context.endpoint ?? context.category;
  if (!context.operation && !where) return message;
  const prefix = [context.operation, where && `via ${where}`].filter(Boolean).join(" ");
  return `${prefix} failed: ${message}`;
}

function withNextCommand(suggestions: string[], context: AzErrorContext): string[] {
  if (!context.nextCommand) return suggestions;
  return [...suggestions, `Run \`${context.nextCommand}\``];
}

export function azNotInstalledError(): AdoError {
  return new AdoError(
    "az CLI is not installed - see https://aka.ms/azure-cli",
    "AZ_NOT_INSTALLED",
  );
}
