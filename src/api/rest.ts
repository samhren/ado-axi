import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azRaw, decodeUtf8, parseAzJson } from "../az.js";
import { withOrgProject, type AdoContext } from "../context.js";
import { AdoError, azNotInstalledError, mapAzError, type AzErrorContext } from "../errors.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RestRequest {
  /** REST area, e.g. "git" or "policy". */
  area: string;
  /** REST resource, e.g. "pullRequestThreads". */
  resource: string;
  routeParameters?: Record<string, string | number | undefined>;
  queryParameters?: Record<string, string | number | boolean | undefined>;
  /**
   * Overrides {@link DEFAULT_API_VERSION}. Must be a version `az devops invoke`
   * can parse - see {@link assertUsableApiVersion}.
   */
  apiVersion?: string;
  httpMethod?: HttpMethod;
  /** Request body; serialized to a UTF-8 temp file and passed with --in-file. */
  body?: unknown;
  /** Caller identity used to build an actionable error. */
  operation: string;
  /** The `ado-axi` command worth running next if this fails. */
  nextCommand?: string;
}

/**
 * The api-version every REST call uses unless the caller overrides it.
 *
 * This is deliberately the *stable* `7.1` rather than `7.1-preview.1`. Before it
 * issues any request, `az devops invoke` pre-parses the version with its own
 * `apiVersionToFloat()` (`azext_devops/dev/team/invoke.py`), which strips the
 * literal `-preview` and calls Python's `float()` on whatever is left. That turns
 * `7.1-preview.1` into `"7.1.1"` and the extension dies with
 * `could not convert string to float: '7.1.1'` - before authenticating, so the
 * failure looks nothing like the api-version problem it is. Reproduced on Azure
 * CLI 2.79.0/2.88.0 with azure-devops 1.0.4 and 1.0.6; it is not fixed upstream.
 *
 * So a `-preview.N` version is simply unreachable through `az devops invoke`.
 * Bare `7.1-preview` parses fine, and a caller that needs a preview-only endpoint
 * can opt in by passing `apiVersion` explicitly.
 */
const DEFAULT_API_VERSION = "7.1";

/**
 * Reject an api-version `az devops invoke` cannot parse, before spawning `az`.
 *
 * Mirrors the extension's own `apiVersionToFloat()`. Catching it here turns an
 * opaque Python `ValueError` into an error that names the flag at fault.
 */
export function assertUsableApiVersion(apiVersion: string, context: AzErrorContext = {}): void {
  if (/^\d+(\.\d+)?$/.test(apiVersion.replace("-preview", ""))) return;
  throw new AdoError(
    `az devops invoke cannot parse the api-version "${apiVersion}"`,
    "VALIDATION_ERROR",
    [
      "Use a stable version such as `7.1`, or a bare `7.1-preview`",
      "A resource-version suffix (`7.1-preview.1`) is not supported: az strips `-preview` and parses the rest as a number",
    ],
    context,
  );
}

/**
 * Call an Azure DevOps REST endpoint through `az devops invoke`.
 *
 * `az devops invoke` reuses the Azure CLI's own credential chain, so no token
 * ever passes through this process - nothing here can leak a PAT into output.
 *
 * The response is captured with `--out-file` and read back as bytes, then decoded
 * as UTF-8. That keeps the payload off the terminal entirely, so a `∞` or an em
 * dash in a review comment cannot be mangled (or crash the Azure CLI) on a
 * console whose code page is not UTF-8.
 */
export async function adoRest<T = unknown>(
  request: RestRequest,
  ctx?: AdoContext,
): Promise<T> {
  const endpoint = `${request.area}/${request.resource}`;
  const errorContext: AzErrorContext = {
    operation: request.operation,
    category: `rest ${endpoint}`,
    endpoint: restEndpointLabel(request),
    ...(request.nextCommand ? { nextCommand: request.nextCommand } : {}),
  };

  const apiVersion = request.apiVersion ?? DEFAULT_API_VERSION;
  assertUsableApiVersion(apiVersion, errorContext);

  const workdir = mkdtempSync(join(tmpdir(), "ado-axi-"));
  const outFile = join(workdir, "response.json");

  try {
    const args = [
      "devops",
      "invoke",
      "--area",
      request.area,
      "--resource",
      request.resource,
      "--http-method",
      request.httpMethod ?? "GET",
      "--api-version",
      apiVersion,
      "--out-file",
      outFile,
    ];

    const routeParams = flattenParams(request.routeParameters);
    if (routeParams.length > 0) args.push("--route-parameters", ...routeParams);

    const queryParams = flattenParams(request.queryParameters);
    if (queryParams.length > 0) args.push("--query-parameters", ...queryParams);

    if (request.body !== undefined) {
      const inFile = join(workdir, "request.json");
      // Written as UTF-8 bytes rather than shelled through argv, so the exact
      // characters the caller supplied reach Azure unchanged.
      writeFileSync(inFile, JSON.stringify(request.body), { encoding: "utf-8" });
      args.push("--in-file", inFile, "--encoding", "utf-8");
    }

    // `az devops invoke` has no --project argument; the project travels as a route parameter.
    const result = await azRaw(withOrgProject(args, ctx, { project: false }));
    if (result.stderr === "ENOENT") throw azNotInstalledError();
    if (result.exitCode !== 0) {
      throw mapAzError(result.stderr, result.exitCode, errorContext);
    }

    const payload = readResponse(outFile) ?? result.stdout;
    if (payload.trim().length === 0) return null as T;
    return parseAzJson<T>(payload, args, errorContext);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/** Read the captured response as raw bytes and decode them as UTF-8. */
function readResponse(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return decodeUtf8(readFileSync(path));
}

function flattenParams(
  params: Record<string, string | number | boolean | undefined> | undefined,
): string[] {
  if (!params) return [];
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
}

function restEndpointLabel(request: RestRequest): string {
  const route = flattenParams(request.routeParameters).join(" ");
  const method = request.httpMethod ?? "GET";
  return `${method} ${request.area}/${request.resource}${route ? ` (${route})` : ""}`;
}

/** A page of results as Azure DevOps returns them from a list endpoint. */
export interface RestPage<T> {
  value?: T[];
  count?: number;
  continuationToken?: string | null;
  /** az snake-cases some response keys when it reshapes them. */
  continuation_token?: string | null;
}

export interface PaginateOptions {
  /** Page size passed as $top. Azure caps most collections well below this. */
  pageSize?: number;
  /** Stop after this many items, so a huge PR cannot run unbounded. */
  limit?: number;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_LIMIT = 2000;

export interface PaginatedResult<T> {
  items: T[];
  /** True when `limit` cut the collection short and more items exist server-side. */
  truncated: boolean;
}

/**
 * Walk a paginated Azure DevOps collection.
 *
 * Azure DevOps is inconsistent here: some endpoints return a `continuationToken`
 * in the body, others only honour `$top`/`$skip`. This handles both - it follows
 * a continuation token when one comes back, and otherwise advances `$skip` until
 * a short page arrives.
 */
export async function adoRestPaginate<T>(
  request: RestRequest,
  ctx?: AdoContext,
  options: PaginateOptions = {},
): Promise<PaginatedResult<T>> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const items: T[] = [];
  let continuationToken: string | undefined;
  let skip = 0;

  for (;;) {
    const page = await adoRest<RestPage<T> | T[]>(
      {
        ...request,
        queryParameters: {
          ...request.queryParameters,
          $top: pageSize,
          ...(continuationToken ? { continuationToken } : { $skip: skip || undefined }),
        },
      },
      ctx,
    );

    const batch = Array.isArray(page) ? page : (page?.value ?? []);
    items.push(...batch);

    if (items.length >= limit) {
      return { items: items.slice(0, limit), truncated: true };
    }

    const nextToken = Array.isArray(page)
      ? undefined
      : (page?.continuationToken ?? page?.continuation_token ?? undefined);

    if (nextToken) {
      continuationToken = nextToken;
      continue;
    }

    // No token: a short page means the collection is exhausted.
    if (batch.length < pageSize) return { items, truncated: false };
    continuationToken = undefined;
    skip += batch.length;
  }
}
