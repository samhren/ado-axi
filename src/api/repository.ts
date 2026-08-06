import { azJson } from "../az.js";
import { withOrgProject, type AdoContext } from "../context.js";
import { AxiError } from "../errors.js";
import type { RepositoryRef } from "./types.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Repository GUID cache, keyed by org + project + repository name.
 *
 * Every Git REST route is addressed by repository GUID, and a single
 * `pr inspect` touches seven of them. Resolving the name once per process keeps
 * that to one extra `az repos show` instead of one per endpoint.
 */
const cache = new Map<string, string>();

function cacheKey(ctx: AdoContext | undefined, name: string): string {
  return `${ctx?.org?.value ?? ""}|${ctx?.project?.value ?? ""}|${name.toLowerCase()}`;
}

/** Seed the cache from a response that already carries the GUID (e.g. a PR's repository ref). */
export function rememberRepositoryId(
  ctx: AdoContext | undefined,
  name: string | undefined,
  id: string | undefined,
): void {
  if (!name || !id) return;
  cache.set(cacheKey(ctx, name), id);
}

/** Reset the cache. Exported for tests; nothing in the CLI needs to call it. */
export function clearRepositoryCache(): void {
  cache.clear();
}

/**
 * Resolve a repository name to its GUID, caching the result.
 * A value that is already a GUID is returned untouched, with no az call.
 */
export async function resolveRepositoryId(
  name: string,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<string> {
  if (GUID.test(name)) return name;

  const key = cacheKey(ctx, name);
  const cached = cache.get(key);
  if (cached) return cached;

  const repo = await azJson<RepositoryRef>(
    withOrgProject(["repos", "show", "--repository", name], ctx),
    {
      operation,
      category: "az repos show",
      nextCommand: "ado-axi repo list",
    },
  );

  if (!repo?.id) {
    throw new AxiError(`Repository "${name}" not found`, "NOT_FOUND", [
      "Run `ado-axi repo list` to see repositories in this project",
    ]);
  }

  cache.set(key, repo.id);
  return repo.id;
}
