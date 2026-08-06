import { azJson } from "../az.js";
import { withOrgProject, type AdoContext } from "../context.js";
import { AxiError } from "../errors.js";
import { adoRest, adoRestPaginate, type PaginatedResult } from "./rest.js";
import { rememberRepositoryId, resolveRepositoryId } from "./repository.js";
import type {
  CommentThread,
  GitChangeItem,
  GitCommitRef,
  PolicyEvaluation,
  PullRequest,
  PullRequestIteration,
  PullRequestPatch,
  PullRequestStatus,
  ReviewerRef,
  ThreadStatus,
  WorkItemRefLite,
} from "./types.js";

/**
 * Everything a Git REST route needs to address one pull request. Derived once
 * from the PR itself, so nothing downstream has to resolve a GUID again.
 */
export interface PrCoordinates {
  pullRequestId: number;
  repositoryId: string;
  repositoryName?: string;
  /** Project name when Azure gave us one, otherwise the project GUID. */
  project: string;
  /** Project GUID - required to build the policy-evaluation artifact id. */
  projectId?: string;
}

/**
 * `az repos pr show` takes only `--id`; the pull request id is unique across the
 * organization, so the command declares no `--project`/`--repository` argument.
 * Passing either makes argparse reject the call outright.
 */
export async function getPullRequest(
  id: number,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<PullRequest> {
  const pr = await azJson<PullRequest>(
    withOrgProject(["repos", "pr", "show", "--id", String(id)], ctx),
    {
      operation,
      category: "az repos pr show",
      nextCommand: "ado-axi pr list --status all",
    },
  );

  if (!pr || typeof pr.pullRequestId !== "number") {
    throw new AxiError(`Pull request #${id} not found`, "NOT_FOUND", [
      "Run `ado-axi pr list --status all` to see pull request ids",
    ]);
  }

  rememberRepositoryId(ctx, pr.repository?.name, pr.repository?.id);
  return pr;
}

/** Derive REST coordinates from a fetched PR, falling back to a name lookup if Azure omitted the GUID. */
export async function coordinatesFor(
  pr: PullRequest,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<PrCoordinates> {
  const project = pr.repository?.project?.name ?? pr.repository?.project?.id ?? ctx?.project?.value;
  if (!project) {
    throw new AxiError(
      "Could not determine which Azure DevOps project this pull request belongs to",
      "PROJECT_NOT_CONFIGURED",
      ["Pass --project <name-or-id>, or set AZURE_DEVOPS_PROJECT"],
    );
  }

  const repositoryId =
    pr.repository?.id ??
    (pr.repository?.name
      ? await resolveRepositoryId(pr.repository.name, ctx, operation)
      : undefined);

  if (!repositoryId) {
    throw new AxiError(
      "Could not determine which repository this pull request belongs to",
      "NOT_FOUND",
      ["Run `ado-axi repo list` to see repositories in this project"],
    );
  }

  return {
    pullRequestId: pr.pullRequestId,
    repositoryId,
    ...(pr.repository?.name ? { repositoryName: pr.repository.name } : {}),
    project,
    ...(pr.repository?.project?.id ? { projectId: pr.repository.project.id } : {}),
  };
}

function gitRoute(coords: PrCoordinates): Record<string, string | number> {
  return {
    project: coords.project,
    repositoryId: coords.repositoryId,
    pullRequestId: coords.pullRequestId,
  };
}

/** Review threads, including every inline comment and its replies. */
export async function listThreads(
  coords: PrCoordinates,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<CommentThread[]> {
  const result = await adoRest<{ value?: CommentThread[] } | CommentThread[]>(
    {
      area: "git",
      resource: "pullRequestThreads",
      routeParameters: gitRoute(coords),
      operation,
      nextCommand: `ado-axi pr threads ${coords.pullRequestId}`,
    },
    ctx,
  );
  return Array.isArray(result) ? result : (result?.value ?? []);
}

/** Build/check statuses posted against the PR. */
export async function listStatuses(
  coords: PrCoordinates,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<PullRequestStatus[]> {
  const result = await adoRest<{ value?: PullRequestStatus[] } | PullRequestStatus[]>(
    {
      area: "git",
      resource: "pullRequestStatuses",
      routeParameters: gitRoute(coords),
      operation,
      nextCommand: `ado-axi pr checks ${coords.pullRequestId}`,
    },
    ctx,
  );
  return Array.isArray(result) ? result : (result?.value ?? []);
}

/**
 * Branch-policy evaluations for the PR.
 *
 * The policy area addresses a PR by artifact id, which needs the project GUID -
 * not the project name - so this is skipped when Azure did not return one.
 */
export async function listPolicyEvaluations(
  coords: PrCoordinates,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<PolicyEvaluation[]> {
  if (!coords.projectId) return [];

  const result = await adoRest<{ value?: PolicyEvaluation[] } | PolicyEvaluation[]>(
    {
      area: "policy",
      resource: "evaluations",
      routeParameters: { project: coords.project },
      queryParameters: {
        artifactId: `vstfs:///CodeReview/CodeReviewId/${coords.projectId}/${coords.pullRequestId}`,
      },
      operation,
      nextCommand: `ado-axi pr checks ${coords.pullRequestId}`,
    },
    ctx,
  );
  return Array.isArray(result) ? result : (result?.value ?? []);
}

/** Commits on the PR's source branch, paginated. */
export async function listCommits(
  coords: PrCoordinates,
  ctx: AdoContext | undefined,
  operation: string,
  limit?: number,
): Promise<PaginatedResult<GitCommitRef>> {
  return adoRestPaginate<GitCommitRef>(
    {
      area: "git",
      resource: "pullRequestCommits",
      routeParameters: gitRoute(coords),
      operation,
    },
    ctx,
    { ...(limit !== undefined ? { limit } : {}) },
  );
}

/**
 * Files touched by the PR.
 *
 * Azure exposes changes per iteration, so this reads the latest iteration and
 * lists its changes - that is the diff as the PR currently stands.
 */
export async function listChangedFiles(
  coords: PrCoordinates,
  ctx: AdoContext | undefined,
  operation: string,
  limit?: number,
): Promise<PaginatedResult<GitChangeItem>> {
  const iterations = await adoRest<
    { value?: PullRequestIteration[] } | PullRequestIteration[]
  >(
    {
      area: "git",
      resource: "pullRequestIterations",
      routeParameters: gitRoute(coords),
      operation,
    },
    ctx,
  );

  const list = Array.isArray(iterations) ? iterations : (iterations?.value ?? []);
  const latest = list.reduce<number | undefined>(
    (max, it) => (typeof it.id === "number" && (max === undefined || it.id > max) ? it.id : max),
    undefined,
  );
  if (latest === undefined) return { items: [], truncated: false };

  return adoRestPaginate<GitChangeItem>(
    {
      area: "git",
      resource: "pullRequestIterationChanges",
      routeParameters: { ...gitRoute(coords), iterationId: latest },
      operation,
    },
    ctx,
    { ...(limit !== undefined ? { limit } : {}) },
  );
}

/** Work items linked to the PR. */
export async function listWorkItems(
  id: number,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<WorkItemRefLite[]> {
  const result = await azJson<WorkItemRefLite[]>(
    withOrgProject(["repos", "pr", "work-item", "list", "--id", String(id)], ctx),
    { operation, category: "az repos pr work-item list" },
  );
  return Array.isArray(result) ? result : [];
}

/** Reviewers and their votes. */
export async function listReviewers(
  id: number,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<ReviewerRef[]> {
  const result = await azJson<ReviewerRef[]>(
    withOrgProject(["repos", "pr", "reviewer", "list", "--id", String(id)], ctx),
    { operation, category: "az repos pr reviewer list" },
  );
  return Array.isArray(result) ? result : [];
}

/**
 * PATCH a pull request with only the fields the caller supplied.
 *
 * Azure treats an absent key as "leave unchanged", so an update that only sets
 * `description` can never clear the title, reviewers, or anything else. The body
 * travels as a UTF-8 file rather than an argv string, which keeps em dashes and
 * other non-ASCII text byte-identical.
 */
export async function updatePullRequest(
  coords: PrCoordinates,
  patch: PullRequestPatch,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<PullRequest> {
  if (Object.keys(patch).length === 0) {
    throw new AxiError("Nothing to update", "VALIDATION_ERROR", [
      "Pass at least one of --title, --description, --description-file, --draft/--no-draft, --target-branch, --status",
    ]);
  }

  return adoRest<PullRequest>(
    {
      area: "git",
      resource: "pullRequests",
      routeParameters: gitRoute(coords),
      httpMethod: "PATCH",
      body: patch,
      operation,
      nextCommand: `ado-axi pr view ${coords.pullRequestId}`,
    },
    ctx,
  );
}

export interface NewCommentOptions {
  content: string;
  /** Reply to an existing thread instead of opening a new one. */
  threadId?: number;
  /** Anchor a new thread to a file, making it an inline comment. */
  filePath?: string;
  line?: number;
  endLine?: number;
}

/** Post a comment: a reply when `threadId` is given, otherwise a new thread. */
export async function createComment(
  coords: PrCoordinates,
  options: NewCommentOptions,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<CommentThread> {
  if (options.threadId !== undefined) {
    const comment = await adoRest<{ id?: number; content?: string }>(
      {
        area: "git",
        resource: "pullRequestThreadComments",
        routeParameters: { ...gitRoute(coords), threadId: options.threadId },
        httpMethod: "POST",
        body: { content: options.content, parentCommentId: 1, commentType: 1 },
        operation,
        nextCommand: `ado-axi pr threads ${coords.pullRequestId}`,
      },
      ctx,
    );
    return { id: options.threadId, comments: [comment] };
  }

  const body: Record<string, unknown> = {
    comments: [{ parentCommentId: 0, content: options.content, commentType: 1 }],
    status: 1, // active
  };

  if (options.filePath) {
    const start = options.line ?? 1;
    body["threadContext"] = {
      filePath: options.filePath,
      rightFileStart: { line: start, offset: 1 },
      rightFileEnd: { line: options.endLine ?? start, offset: 1 },
    };
  }

  return adoRest<CommentThread>(
    {
      area: "git",
      resource: "pullRequestThreads",
      routeParameters: gitRoute(coords),
      httpMethod: "POST",
      body,
      operation,
      nextCommand: `ado-axi pr threads ${coords.pullRequestId}`,
    },
    ctx,
  );
}

/** Set a thread's status - the API call behind `pr thread resolve`. */
export async function setThreadStatus(
  coords: PrCoordinates,
  threadId: number,
  status: ThreadStatus,
  ctx: AdoContext | undefined,
  operation: string,
): Promise<CommentThread> {
  return adoRest<CommentThread>(
    {
      area: "git",
      resource: "pullRequestThreads",
      routeParameters: { ...gitRoute(coords), threadId },
      httpMethod: "PATCH",
      body: { status },
      operation,
      nextCommand: `ado-axi pr threads ${coords.pullRequestId} --unresolved`,
    },
    ctx,
  );
}
