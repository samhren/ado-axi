import { execFileSync } from "node:child_process";
import { supportsOrgFlag, supportsProjectFlag } from "./api/az-capabilities.js";

export type ContextSource = "flag" | "env" | "git" | "default";

export interface ResolvedValue {
  value: string;
  source: ContextSource;
}

export interface AdoContext {
  org?: ResolvedValue;
  project?: ResolvedValue;
  repo?: ResolvedValue;
}

/**
 * Resolve organization, project, and (when available) the current repository.
 * Priority for each: explicit flag > env var > Azure Repos git remote > az devops configure default.
 * "default" means we intentionally omit the flag from the az call and let the
 * child `az` process apply its own `az devops configure -d` default.
 */
export function resolveContext(orgFlag?: string, projectFlag?: string): AdoContext {
  const org = resolveOrg(orgFlag);
  const project = resolveProject(projectFlag, org);
  const repo = resolveRepo(org);
  return { org, project, repo };
}

function resolveRepo(org: ResolvedValue | undefined): ResolvedValue | undefined {
  if (org?.source !== "git") return undefined;
  const fromGit = parseGitRemote();
  return fromGit?.repo ? { value: fromGit.repo, source: "git" } : undefined;
}

function resolveOrg(flagValue?: string): ResolvedValue | undefined {
  if (flagValue) return { value: normalizeOrgUrl(flagValue), source: "flag" };

  const envValue = process.env["AZURE_DEVOPS_ORG_URL"] ?? process.env["ADO_AXI_ORG"];
  if (envValue) return { value: normalizeOrgUrl(envValue), source: "env" };

  const fromGit = parseGitRemote();
  if (fromGit?.org) return { value: fromGit.org, source: "git" };

  return undefined;
}

function resolveProject(
  flagValue: string | undefined,
  org: ResolvedValue | undefined,
): ResolvedValue | undefined {
  if (flagValue) return { value: flagValue, source: "flag" };

  const envValue = process.env["AZURE_DEVOPS_PROJECT"] ?? process.env["ADO_AXI_PROJECT"];
  if (envValue) return { value: envValue, source: "env" };

  // Only trust the git-detected project when the org also came from git, so a
  // project name from an unrelated repo never leaks into an explicit --org call.
  if (org?.source === "git") {
    const fromGit = parseGitRemote();
    if (fromGit?.project) return { value: fromGit.project, source: "git" };
  }

  return undefined;
}

function normalizeOrgUrl(value: string): string {
  // Accept a bare org name ("myorg") or a full URL; az wants a full URL.
  if (/^https?:\/\//i.test(value)) return value;
  if (/\.visualstudio\.com/i.test(value)) return `https://${value}/`;
  return `https://dev.azure.com/${value}/`;
}

interface GitRemoteMatch {
  org?: string;
  project?: string;
  repo?: string;
}

function parseGitRemote(): GitRemoteMatch | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }

  // https://dev.azure.com/{org}/{project}/_git/{repo}
  // https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
  let match = url.match(/dev\.azure\.com\/(?:[^/@]+@)?([^/]+)\/([^/]+)\/_git\/([^/]+)/);
  if (match) {
    return {
      org: match[1],
      project: decodeURIComponent(match[2]),
      repo: decodeURIComponent(match[3]),
    };
  }

  // https://{org}.visualstudio.com/{project}/_git/{repo}
  match = url.match(/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/);
  if (match) {
    return {
      org: match[1],
      project: decodeURIComponent(match[2]),
      repo: decodeURIComponent(match[3]),
    };
  }

  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  match = url.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) {
    return {
      org: match[1],
      project: decodeURIComponent(match[2]),
      repo: decodeURIComponent(match[3]),
    };
  }

  return undefined;
}

/**
 * Append --organization/--project flags to an az argv.
 *
 * Skips unresolved or default-sourced values, and - critically - only appends a
 * flag the target az command actually declares. `az repos pr update` has no
 * `--project` argument, so blindly appending one made argparse reject the whole
 * call; `src/api/az-capabilities.ts` is the single source of truth for which
 * commands accept what. `options.project: false` can suppress the flag further,
 * but never force it on.
 */
export function withOrgProject(
  args: string[],
  ctx: AdoContext | undefined,
  options: { project?: boolean } = {},
): string[] {
  const out = [...args];
  if (ctx?.org && ctx.org.source !== "default" && supportsOrgFlag(args)) {
    out.push("--organization", ctx.org.value);
  }
  if (
    (options.project ?? true) &&
    supportsProjectFlag(args) &&
    ctx?.project &&
    ctx.project.source !== "default"
  ) {
    out.push("--project", ctx.project.value);
  }
  return out;
}
