import { readFileSync, writeFileSync } from "node:fs";
import type { execFile } from "node:child_process";

/**
 * A routing mock for the single `execFile("az", ...)` call site.
 *
 * Responses are returned as UTF-8 Buffers, the way Node hands them back when
 * `encoding: "buffer"` is set, so the tests exercise the real decode path rather
 * than a string shortcut. REST calls made through `az devops invoke` are answered
 * by writing the payload to the `--out-file` path the CLI passed, which is exactly
 * how the production code reads them back.
 */

export type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

export interface AzResponse {
  /** JSON payload; serialized and returned (or written to --out-file for REST calls). */
  json?: unknown;
  /** Raw stdout, when a test needs a non-JSON payload. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export type AzHandler = (args: string[], call: number) => AzResponse;

export interface AzCall {
  args: string[];
  /** Body the CLI wrote for --in-file, parsed back from disk. */
  body?: unknown;
}

/** Leading non-flag words of an az argv, e.g. "repos pr show". */
export function commandPath(args: string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  return words.join(" ");
}

export function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * A stable key for one az invocation:
 *   "repos pr show"
 *   "rest GET git/pullRequestThreads"
 */
export function routeKey(args: string[]): string {
  const path = commandPath(args);
  if (path !== "devops invoke") return path;
  const method = flagValue(args, "--http-method") ?? "GET";
  return `rest ${method} ${flagValue(args, "--area")}/${flagValue(args, "--resource")}`;
}

export interface AzMock {
  /** Every az invocation seen so far, in order. */
  calls: AzCall[];
  /** Calls matching a route key, e.g. "rest PATCH git/pullRequests". */
  callsFor(key: string): AzCall[];
  countFor(key: string): number;
  implementation: (
    cmd: string,
    args: string[],
    opts: unknown,
    callback: unknown,
  ) => ReturnType<typeof execFile>;
}

/**
 * Build an execFile implementation from a route -> response table.
 * A route may map to a single response or to a function of (args, callIndex)
 * so a test can return successive pages.
 */
export function createAzMock(
  routes: Record<string, AzResponse | AzHandler>,
): AzMock {
  const calls: AzCall[] = [];
  const perRoute = new Map<string, number>();

  const callsFor = (key: string) => calls.filter((call) => routeKey(call.args) === key);

  return {
    calls,
    callsFor,
    countFor: (key: string) => callsFor(key).length,
    implementation: (_cmd, args, _opts, callback) => {
      const key = routeKey(args);
      const index = perRoute.get(key) ?? 0;
      perRoute.set(key, index + 1);

      calls.push({ args: [...args], ...(readInFile(args) as { body?: unknown }) });

      const route = routes[key];
      const response: AzResponse =
        route === undefined
          ? { stderr: `ERROR: unmocked az route: ${key}`, exitCode: 1 }
          : typeof route === "function"
            ? route(args, index)
            : route;

      const payload =
        response.stdout ?? (response.json === undefined ? "" : JSON.stringify(response.json));

      const outFile = flagValue(args, "--out-file");
      let stdout = payload;
      if (outFile && (response.exitCode ?? 0) === 0) {
        // `az devops invoke --out-file` writes the body to disk; the CLI reads
        // the bytes back rather than trusting whatever reached the terminal.
        writeFileSync(outFile, payload, { encoding: "utf-8" });
        stdout = "";
      }

      const cb = callback as ExecFileCallback;
      const exitCode = response.exitCode ?? 0;
      if (exitCode === 0) {
        cb(null, Buffer.from(stdout, "utf-8"), Buffer.from(response.stderr ?? "", "utf-8"));
      } else {
        cb(
          Object.assign(new Error("az failed"), { code: exitCode }),
          Buffer.from(stdout, "utf-8"),
          Buffer.from(response.stderr ?? "", "utf-8"),
        );
      }
      return {} as ReturnType<typeof execFile>;
    },
  };
}

function readInFile(args: string[]): { body?: unknown } {
  const inFile = flagValue(args, "--in-file");
  if (!inFile) return {};
  try {
    return { body: JSON.parse(readFileSync(inFile, "utf-8")) };
  } catch {
    return {};
  }
}

/** Collect CLI stdout for assertions. */
export function createStdout() {
  let output = "";
  return {
    stdout: {
      write(chunk: string) {
        output += chunk;
      },
    },
    read() {
      return output;
    },
  };
}
