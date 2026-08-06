import type { AdoContext } from "../context.js";
import { withOrgProject } from "../context.js";
import { azJson } from "../az.js";
import { AxiError } from "../errors.js";
import { getSuggestions } from "../suggestions.js";
import { takeFlag, takeBoolFlag, takeNumber, takeAllFlags } from "../args.js";
import { takeBody } from "../body.js";
import { formatCountLine } from "../format.js";
import {
  field,
  pluck,
  lower,
  boolYesNo,
  custom,
  renderBlock,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";
import {
  coordinatesFor,
  createComment,
  getPullRequest,
  listChangedFiles,
  listCommits,
  listPolicyEvaluations,
  listStatuses,
  listThreads,
  listWorkItems,
  setThreadStatus,
  updatePullRequest,
} from "../api/pull-requests.js";
import {
  normalizeThreadStatus,
  THREAD_STATUSES,
  type PullRequest,
  type PullRequestPatch,
} from "../api/types.js";
import {
  bodyText,
  branchName,
  checkSummary,
  filterThreads,
  reviewSummary,
  toCheckViews,
  toCodeScanFindings,
  toCommitViews,
  toFileViews,
  toPolicyViews,
  toPullRequestView,
  toReviewerViews,
  toRefName,
  toThreadView,
  toWorkItemViews,
  voteLabel,
  type ThreadView,
} from "./pr-format.js";

interface Reviewer {
  displayName?: string;
  uniqueName?: string;
  vote?: number;
  isRequired?: boolean;
}

interface WorkItemRef {
  id?: string | number;
  url?: string;
}

type PrItem = PullRequest;

function reviewerNames(reviewers: Reviewer[] | undefined): string {
  if (!reviewers || reviewers.length === 0) return "none";
  return reviewers
    .map((r) => {
      const name = r.displayName ?? r.uniqueName ?? "unknown";
      const vote = voteLabel(r.vote);
      return r.isRequired ? `${name} (${vote}, required)` : `${name} (${vote})`;
    })
    .join(", ");
}

const reviewerSchema: FieldDef[] = [
  custom("reviewer", (r: Reviewer) => r.displayName ?? r.uniqueName ?? "unknown"),
  custom("vote", (r: Reviewer) => voteLabel(r.vote)),
  boolYesNo("isRequired", "required"),
];

const workItemRefSchema: FieldDef[] = [field("id"), field("url")];

const listSchema: FieldDef[] = [
  custom("id", (i: PrItem) => i.pullRequestId),
  field("title"),
  lower("status"),
  pluck("createdBy", "displayName", "author"),
  boolYesNo("isDraft", "draft"),
];

const viewSchema: FieldDef[] = [
  custom("id", (i: PrItem) => i.pullRequestId),
  field("title"),
  lower("status"),
  pluck("createdBy", "displayName", "author"),
  boolYesNo("isDraft", "draft"),
  custom("source", (i: PrItem) => branchName(i.sourceRefName)),
  custom("target", (i: PrItem) => branchName(i.targetRefName)),
  custom("reviewers", (i: PrItem) => reviewSummary(i.reviewers)),
  custom("reviewer_names", (i: PrItem) => reviewerNames(i.reviewers)),
  custom("description", (i: PrItem) => bodyText(i.description, false)),
];

const viewSchemaFull: FieldDef[] = viewSchema.map((f) =>
  "as" in f && f.as === "description"
    ? custom("description", (i: PrItem) => bodyText(i.description, true))
    : f,
);

/** Default caps so a very large PR cannot produce unbounded output. */
const DEFAULT_COMMIT_LIMIT = 100;
const DEFAULT_FILE_LIMIT = 200;

export const PR_HELP = `usage: ado-axi pr <subcommand> [flags]
subcommands[19]:
  list, view <id>, inspect <id>, create, update <id>, comment <id>, threads <id>, thread list|resolve|reply <id>, checks <id>, commits <id>, files <id>, complete <id>, review <id>, reviewers <id>, add-reviewer <id>, remove-reviewer <id>, work-items <id>, link-work-item <id>, unlink-work-item <id>
flags{list}:
  --status <active|completed|abandoned|all> (default active), --repository <name>, --creator <email>, --reviewer <email>, --source-branch <name>, --target-branch <name>, --top <n> (default 50)
flags{view}:
  --full (complete description, no truncation)
flags{inspect}:
  --full (complete description and comment text), --json (raw JSON, exact Unicode), --include-system (keep Azure-generated threads), --commit-limit <n> (default 100), --file-limit <n> (default 200)
flags{create}:
  --title <text> (required), --source-branch <name> (required), --target-branch <name> (required), --repository <name>, --description <text> or --description-file <path>, --draft, --work-items <id> (repeatable), --required-reviewers <email> (repeatable)
flags{update}:
  --title <text>, --description <text> or --description-file <path>, --draft, --no-draft, --target-branch <name>, --status <active|abandoned>, --dry-run (show the intended change without sending it)
flags{comment}:
  --description <text> or --description-file <path> (required), --thread-id <n> (reply to a thread), --file <path> and --line <n> (anchor an inline comment), --end-line <n>
flags{threads}:
  --unresolved (only threads still needing attention), --author <name-or-email>, --code-scan (only SonarQube/DevOpsCodeScan findings), --include-system, --full, --json
flags{thread resolve}:
  --thread-id <n> (required), --status <active|fixed|wontFix|closed|byDesign|pending> (default closed)
flags{thread reply}:
  --thread-id <n> (required), --description <text> or --description-file <path> (required)
flags{checks}:
  --json (raw statuses and policy evaluations)
flags{commits}:
  --limit <n> (default 100)
flags{files}:
  --limit <n> (default 200)
flags{complete}:
  --squash, --delete-source-branch, --bypass-policy, --merge-commit-message <text>
flags{review}:
  --approve, --reject, --wait, --approve-with-suggestions, --reset
flags{add-reviewer}:
  --reviewers <email> (required, repeatable), --required (mark as a required reviewer)
flags{remove-reviewer}:
  --reviewers <email> (required, repeatable)
flags{link-work-item}:
  --work-items <id> (required, repeatable)
flags{unlink-work-item}:
  --work-items <id> (required, repeatable)
examples:
  ado-axi pr inspect 2613 --full
  ado-axi pr threads 2613 --unresolved
  ado-axi pr update 2613 --description-file ./description.md --dry-run
  ado-axi pr thread resolve 2613 --thread-id 98765
  ado-axi pr comment 2613 --description "Fixed in the latest push"
  ado-axi pr checks 2613
  ado-axi pr create --title "Fix login" --source-branch feature/login --target-branch main`;

async function prList(args: string[], ctx?: AdoContext): Promise<string> {
  const status = takeFlag(args, "--status") ?? "active";
  const repository = takeFlag(args, "--repository") ?? ctx?.repo?.value;
  const creator = takeFlag(args, "--creator");
  const reviewer = takeFlag(args, "--reviewer");
  const sourceBranch = takeFlag(args, "--source-branch");
  const targetBranch = takeFlag(args, "--target-branch");
  const top = Number(takeFlag(args, "--top") ?? "50");

  const azArgs = ["repos", "pr", "list", "--status", status, "--top", String(top)];
  if (repository) azArgs.push("--repository", repository);
  if (creator) azArgs.push("--creator", creator);
  if (reviewer) azArgs.push("--reviewer", reviewer);
  if (sourceBranch) azArgs.push("--source-branch", sourceBranch);
  if (targetBranch) azArgs.push("--target-branch", targetBranch);

  const items = await azJson<PrItem[]>(withOrgProject(azArgs, ctx), {
    operation: "pr list",
    category: "az repos pr list",
  });
  const results = Array.isArray(items) ? items : [];
  const isEmpty = results.length === 0;

  const countLine = isEmpty
    ? `count: 0 ${status} pull requests`
    : formatCountLine({ count: results.length, limit: top });

  return renderOutput([
    countLine,
    isEmpty ? "" : renderList("pull_requests", results, listSchema),
    renderHelp(
      getSuggestions({ domain: "pr", action: "list", isEmpty, id: results[0]?.pullRequestId, ctx }),
    ),
  ]);
}

async function prView(args: string[], ctx?: AdoContext): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const id = takeNumber(args, "PR");

  const pr = await getPullRequest(id, ctx, "pr view");

  return renderOutput([
    renderDetail("pull_request", pr, full ? viewSchemaFull : viewSchema),
    renderHelp(getSuggestions({ domain: "pr", action: "view", id, state: pr.status, ctx })),
  ]);
}

/**
 * One-call PR inspection: metadata, reviewers, work items, commits, files,
 * checks, policy evaluations, and every review thread.
 *
 * The seven sub-resources are independent, so they are fetched concurrently. A
 * single sub-resource the caller lacks permission for (branch policies are the
 * usual one) degrades to a warning rather than failing the whole inspection.
 */
async function prInspect(args: string[], ctx?: AdoContext): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const asJson = takeBoolFlag(args, "--json");
  const includeSystem = takeBoolFlag(args, "--include-system");
  const commitLimit = Number(takeFlag(args, "--commit-limit") ?? String(DEFAULT_COMMIT_LIMIT));
  const fileLimit = Number(takeFlag(args, "--file-limit") ?? String(DEFAULT_FILE_LIMIT));
  const id = takeNumber(args, "PR");

  const operation = "pr inspect";
  const pr = await getPullRequest(id, ctx, operation);
  const coords = await coordinatesFor(pr, ctx, operation);

  const warnings: string[] = [];
  const settled = await Promise.allSettled([
    listThreads(coords, ctx, operation),
    listStatuses(coords, ctx, operation),
    listPolicyEvaluations(coords, ctx, operation),
    listCommits(coords, ctx, operation, commitLimit),
    listChangedFiles(coords, ctx, operation, fileLimit),
    listWorkItems(id, ctx, operation),
  ]);

  const [threadsResult, statusesResult, policiesResult, commitsResult, filesResult, workItemsResult] =
    settled;

  const threads = unwrap(threadsResult, "review threads", warnings) ?? [];
  const statuses = unwrap(statusesResult, "checks", warnings) ?? [];
  const policies = unwrap(policiesResult, "policy evaluations", warnings) ?? [];
  const commits = unwrap(commitsResult, "commits", warnings) ?? { items: [], truncated: false };
  const files = unwrap(filesResult, "changed files", warnings) ?? { items: [], truncated: false };
  const workItems = unwrap(workItemsResult, "linked work items", warnings) ?? [];

  const visibleThreads = filterThreads(threads, { includeSystem });
  const threadViews = visibleThreads.map((thread) => toThreadView(thread, full));
  const codeScanViews = toCodeScanFindings(threadViews);
  const checks = toCheckViews(statuses);
  const policyViews = toPolicyViews(policies);
  const commitViews = toCommitViews(commits.items);
  const fileViews = toFileViews(files.items);

  if (asJson) {
    return `${JSON.stringify(
      {
        pull_request: pr,
        threads: visibleThreads,
        checks: statuses,
        policy_evaluations: policies,
        commits: commits.items,
        files: files.items,
        work_items: workItems,
        truncated: { commits: commits.truncated, files: files.truncated },
        warnings,
      },
      null,
      2,
    )}\n`;
  }

  const unresolved = threadViews.filter((thread) => thread.resolved === "no").length;

  return renderOutput([
    renderBlock("pull_request", toPullRequestView(pr, full)),
    renderBlock("summary", {
      checks: checkSummary(checks, policyViews),
      threads: `${threadViews.length} total, ${unresolved} unresolved`,
      code_scan_findings: codeScanViews.length,
      commits: commits.truncated ? `${commitViews.length}+ (truncated)` : commitViews.length,
      files: files.truncated ? `${fileViews.length}+ (truncated)` : fileViews.length,
    }),
    section("reviewers", toReviewerViews(pr.reviewers)),
    section("work_items", toWorkItemViews(workItems)),
    section("checks", checks),
    section("policies", policyViews),
    section("commits", commitViews),
    section("files", fileViews),
    section("threads", threadViews),
    codeScanViews.length > 0 ? renderBlock("code_scan_findings", codeScanViews) : "",
    warnings.length > 0 ? renderBlock("warnings", warnings) : "",
    renderHelp(getSuggestions({ domain: "pr", action: "inspect", id, state: pr.status, ctx })),
  ]);
}

/** Render a labelled collection, or a definitive empty line when there is nothing to show. */
function section(label: string, items: unknown[]): string {
  if (items.length === 0) return `count: 0 ${label.replace(/_/g, " ")}`;
  return renderBlock(label, items);
}

function unwrap<T>(
  result: PromiseSettledResult<T>,
  label: string,
  warnings: string[],
): T | undefined {
  if (result.status === "fulfilled") return result.value;
  const reason = result.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  warnings.push(`could not read ${label}: ${message}`);
  return undefined;
}

/**
 * Update a pull request, sending only the fields the caller named.
 *
 * Azure's PATCH semantics treat an absent key as "leave unchanged", so this can
 * never clear a field nobody mentioned. After a real (non-dry-run) update the PR
 * is re-fetched and each requested field is compared against what came back.
 */
async function prUpdate(args: string[], ctx?: AdoContext): Promise<string> {
  const dryRun = takeBoolFlag(args, "--dry-run");
  const draft = takeBoolFlag(args, "--draft");
  const noDraft = takeBoolFlag(args, "--no-draft");
  const title = takeFlag(args, "--title");
  const targetBranch = takeFlag(args, "--target-branch");
  const sourceBranch = takeFlag(args, "--source-branch");
  const status = takeFlag(args, "--status");
  const description = takeBody(args);
  const id = takeNumber(args, "PR");

  if (draft && noDraft) {
    throw new AxiError("Pass either --draft or --no-draft, not both", "VALIDATION_ERROR");
  }
  if (sourceBranch !== undefined) {
    throw new AxiError(
      "Azure DevOps does not allow changing a pull request's source branch",
      "VALIDATION_ERROR",
      [
        "Close this pull request and open a new one from the intended source branch",
        "Use --target-branch to retarget the pull request instead",
      ],
    );
  }
  if (status !== undefined && !["active", "abandoned"].includes(status.toLowerCase())) {
    throw new AxiError(
      `Unsupported --status "${status}" (allowed: active, abandoned)`,
      "VALIDATION_ERROR",
      ["Run `ado-axi pr complete <id>` to merge a pull request"],
    );
  }

  const patch: PullRequestPatch = {};
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (draft) patch.isDraft = true;
  if (noDraft) patch.isDraft = false;
  if (targetBranch !== undefined) patch.targetRefName = toRefName(targetBranch);
  if (status !== undefined) patch.status = status.toLowerCase() as PullRequestPatch["status"];

  const fields = Object.keys(patch);
  if (fields.length === 0) {
    throw new AxiError("Nothing to update", "VALIDATION_ERROR", [
      "Pass at least one of --title, --description, --description-file, --draft/--no-draft, --target-branch, --status",
    ]);
  }

  const operation = "pr update";
  const current = await getPullRequest(id, ctx, operation);

  if (dryRun) {
    return renderOutput([
      renderBlock("dry_run", {
        id,
        fields: fields.join(", "),
        applied: "no",
        note: "no request was sent to Azure DevOps",
      }),
      renderBlock(
        "changes",
        fields.map((name) => ({
          field: name,
          current: previewValue(currentValueFor(current, name)),
          proposed: previewValue(patch[name as keyof PullRequestPatch]),
        })),
      ),
      renderHelp([
        `Run \`ado-axi pr update ${id} ${fields.map(flagFor).join(" ")}\` without --dry-run to apply it`,
      ]),
    ]);
  }

  const coords = await coordinatesFor(current, ctx, operation);
  await updatePullRequest(coords, patch, ctx, operation);

  // Verify against a fresh read rather than trusting the PATCH response.
  const verified = await getPullRequest(id, ctx, operation);
  const results = fields.map((name) => ({
    field: name,
    applied: matches(verified, name, patch[name as keyof PullRequestPatch]) ? "yes" : "no",
    value: previewValue(currentValueFor(verified, name)),
  }));
  const allApplied = results.every((r) => r.applied === "yes");

  return renderOutput([
    renderBlock("updated", {
      id,
      fields: fields.join(", "),
      verified: allApplied ? "yes" : "no",
    }),
    renderBlock("verification", results),
    renderHelp(getSuggestions({ domain: "pr", action: "update", id, ctx })),
  ]);
}

function flagFor(name: string): string {
  switch (name) {
    case "title":
      return '--title "..."';
    case "description":
      return "--description-file <path>";
    case "isDraft":
      return "--draft";
    case "targetRefName":
      return "--target-branch <name>";
    default:
      return `--${name}`;
  }
}

function currentValueFor(pr: PullRequest, field: string): unknown {
  switch (field) {
    case "title":
      return pr.title;
    case "description":
      return pr.description;
    case "isDraft":
      return pr.isDraft;
    case "targetRefName":
      return pr.targetRefName;
    case "status":
      return pr.status;
    default:
      return undefined;
  }
}

function matches(pr: PullRequest, field: string, expected: unknown): boolean {
  const actual = currentValueFor(pr, field);
  if (typeof expected === "string" && typeof actual === "string") {
    return actual.trim() === expected.trim();
  }
  return actual === expected;
}

const PREVIEW_CHARS = 160;

function previewValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : String(value);
  const single = text.replace(/\r?\n/g, "\\n");
  return single.length > PREVIEW_CHARS ? `${single.slice(0, PREVIEW_CHARS)}... (${text.length} chars)` : single;
}

async function prComment(args: string[], ctx?: AdoContext): Promise<string> {
  const threadIdRaw = takeFlag(args, "--thread-id");
  const filePath = takeFlag(args, "--file");
  const lineRaw = takeFlag(args, "--line");
  const endLineRaw = takeFlag(args, "--end-line");
  const content = takeBody(args, { required: true });
  const id = takeNumber(args, "PR");

  if (lineRaw !== undefined && filePath === undefined) {
    throw new AxiError("--line requires --file", "VALIDATION_ERROR", [
      "Pass --file <path-in-repo> alongside --line <n> to anchor an inline comment",
    ]);
  }

  const operation = "pr comment";
  const pr = await getPullRequest(id, ctx, operation);
  const coords = await coordinatesFor(pr, ctx, operation);

  const thread = await createComment(
    coords,
    {
      content,
      ...(threadIdRaw !== undefined ? { threadId: Number(threadIdRaw) } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(lineRaw !== undefined ? { line: Number(lineRaw) } : {}),
      ...(endLineRaw !== undefined ? { endLine: Number(endLineRaw) } : {}),
    },
    ctx,
    operation,
  );

  return renderOutput([
    renderBlock("comment_posted", {
      pull_request: id,
      thread: thread?.id ?? Number(threadIdRaw ?? 0),
      reply: threadIdRaw !== undefined ? "yes" : "no",
      file: filePath ?? "",
      line: lineRaw ?? "",
    }),
    renderHelp(getSuggestions({ domain: "pr", action: "comment", id, ctx })),
  ]);
}

async function prThreads(args: string[], ctx?: AdoContext): Promise<string> {
  const unresolvedOnly = takeBoolFlag(args, "--unresolved");
  const codeScanOnly = takeBoolFlag(args, "--code-scan");
  const includeSystem = takeBoolFlag(args, "--include-system");
  const full = takeBoolFlag(args, "--full");
  const asJson = takeBoolFlag(args, "--json");
  const author = takeFlag(args, "--author");
  const id = takeNumber(args, "PR");

  const operation = "pr threads";
  const pr = await getPullRequest(id, ctx, operation);
  const coords = await coordinatesFor(pr, ctx, operation);
  const threads = await listThreads(coords, ctx, operation);

  const filtered = filterThreads(threads, {
    unresolvedOnly,
    includeSystem,
    codeScanOnly,
    ...(author !== undefined ? { author } : {}),
  });

  if (asJson) {
    return `${JSON.stringify({ pull_request: id, threads: filtered }, null, 2)}\n`;
  }

  const views: ThreadView[] = filtered.map((thread) => toThreadView(thread, full));
  const isEmpty = views.length === 0;
  const label = unresolvedOnly ? "unresolved review threads" : "review threads";

  return renderOutput([
    isEmpty ? `count: 0 ${label}` : `count: ${views.length} ${label}`,
    isEmpty ? "" : renderBlock("threads", views),
    renderHelp(
      getSuggestions({
        domain: "pr",
        action: "threads",
        id,
        isEmpty,
        ctx,
        threadId: views[0]?.thread ?? undefined,
      }),
    ),
  ]);
}

async function prThreadResolve(args: string[], ctx?: AdoContext): Promise<string> {
  const threadIdRaw = takeFlag(args, "--thread-id");
  const statusRaw = takeFlag(args, "--status") ?? "closed";
  const id = takeNumber(args, "PR");

  if (threadIdRaw === undefined) {
    throw new AxiError("--thread-id is required", "VALIDATION_ERROR", [
      `Run \`ado-axi pr threads ${id}\` to see thread ids`,
    ]);
  }
  const status = normalizeThreadStatus(statusRaw);
  if (!status) {
    throw new AxiError(
      `Unknown thread status "${statusRaw}" (allowed: ${THREAD_STATUSES.join(", ")})`,
      "VALIDATION_ERROR",
    );
  }

  const operation = "pr thread resolve";
  const threadId = Number(threadIdRaw);
  const pr = await getPullRequest(id, ctx, operation);
  const coords = await coordinatesFor(pr, ctx, operation);

  const existing = (await listThreads(coords, ctx, operation)).find((t) => t.id === threadId);
  if (!existing) {
    throw new AxiError(`Thread ${threadId} does not exist on pull request #${id}`, "NOT_FOUND", [
      `Run \`ado-axi pr threads ${id}\` to see thread ids`,
    ]);
  }
  if ((existing.status ?? "").toLowerCase() === status.toLowerCase()) {
    return renderOutput([
      renderBlock("thread", { pull_request: id, thread: threadId, status, already: true }),
      renderHelp(getSuggestions({ domain: "pr", action: "thread-resolve", id, ctx })),
    ]);
  }

  const updated = await setThreadStatus(coords, threadId, status, ctx, operation);

  return renderOutput([
    renderBlock("thread", {
      pull_request: id,
      thread: threadId,
      status: (updated?.status ?? status).toLowerCase(),
      resolved: "yes",
    }),
    renderHelp(getSuggestions({ domain: "pr", action: "thread-resolve", id, ctx })),
  ]);
}

async function prThread(args: string[], ctx?: AdoContext): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return prThreads(rest, ctx);
    case "resolve":
      return prThreadResolve(rest, ctx);
    case "reply":
      return prThreadReply(rest, ctx);
    default:
      throw new AxiError(`Unknown pr thread subcommand: ${sub ?? "(none)"}`, "VALIDATION_ERROR", [
        "Use `ado-axi pr thread list <id>`, `ado-axi pr thread resolve <id> --thread-id <n>`, or `ado-axi pr thread reply <id> --thread-id <n> --description \"...\"`",
      ]);
  }
}

/** `pr thread reply` is `pr comment --thread-id` with the flag made mandatory. */
async function prThreadReply(args: string[], ctx?: AdoContext): Promise<string> {
  if (args.every((a) => a !== "--thread-id" && !a.startsWith("--thread-id="))) {
    throw new AxiError("--thread-id is required", "VALIDATION_ERROR", [
      "Run `ado-axi pr threads <id>` to see thread ids",
    ]);
  }
  return prComment(args, ctx);
}

async function prChecks(args: string[], ctx?: AdoContext): Promise<string> {
  const asJson = takeBoolFlag(args, "--json");
  const id = takeNumber(args, "PR");

  const operation = "pr checks";
  const pr = await getPullRequest(id, ctx, operation);
  const coords = await coordinatesFor(pr, ctx, operation);

  const [statuses, policies] = await Promise.all([
    listStatuses(coords, ctx, operation),
    listPolicyEvaluations(coords, ctx, operation),
  ]);

  if (asJson) {
    return `${JSON.stringify({ pull_request: id, checks: statuses, policy_evaluations: policies }, null, 2)}\n`;
  }

  const checks = toCheckViews(statuses);
  const policyViews = toPolicyViews(policies);

  return renderOutput([
    `summary: ${checkSummary(checks, policyViews)}`,
    section("checks", checks),
    section("policies", policyViews),
    renderHelp(getSuggestions({ domain: "pr", action: "checks", id, state: pr.status, ctx })),
  ]);
}

async function prCommits(args: string[], ctx?: AdoContext): Promise<string> {
  const limit = Number(takeFlag(args, "--limit") ?? String(DEFAULT_COMMIT_LIMIT));
  const id = takeNumber(args, "PR");

  const operation = "pr commits";
  const pr = await getPullRequest(id, ctx, operation);
  const coords = await coordinatesFor(pr, ctx, operation);
  const commits = await listCommits(coords, ctx, operation, limit);
  const views = toCommitViews(commits.items);

  return renderOutput([
    views.length === 0
      ? "count: 0 commits"
      : formatCountLine({ count: views.length, ...(commits.truncated ? { limit } : {}) }),
    views.length === 0 ? "" : renderBlock("commits", views),
    renderHelp(getSuggestions({ domain: "pr", action: "commits", id, ctx })),
  ]);
}

async function prFiles(args: string[], ctx?: AdoContext): Promise<string> {
  const limit = Number(takeFlag(args, "--limit") ?? String(DEFAULT_FILE_LIMIT));
  const id = takeNumber(args, "PR");

  const operation = "pr files";
  const pr = await getPullRequest(id, ctx, operation);
  const coords = await coordinatesFor(pr, ctx, operation);
  const files = await listChangedFiles(coords, ctx, operation, limit);
  const views = toFileViews(files.items);

  return renderOutput([
    views.length === 0
      ? "count: 0 changed files"
      : formatCountLine({ count: views.length, ...(files.truncated ? { limit } : {}) }),
    views.length === 0 ? "" : renderBlock("files", views),
    renderHelp(getSuggestions({ domain: "pr", action: "files", id, ctx })),
  ]);
}

async function prCreate(args: string[], ctx?: AdoContext): Promise<string> {
  const title = takeFlag(args, "--title");
  if (!title) throw new AxiError("--title is required", "VALIDATION_ERROR");
  const sourceBranch = takeFlag(args, "--source-branch");
  if (!sourceBranch) throw new AxiError("--source-branch is required", "VALIDATION_ERROR");
  const targetBranch = takeFlag(args, "--target-branch");
  if (!targetBranch) throw new AxiError("--target-branch is required", "VALIDATION_ERROR");
  const repository = takeFlag(args, "--repository") ?? ctx?.repo?.value;
  if (!repository) {
    throw new AxiError("--repository is required", "VALIDATION_ERROR", [
      "Pass --repository <name>, or run this from a clone of the target Azure Repos repository",
    ]);
  }
  const description = takeBody(args);
  const draft = takeBoolFlag(args, "--draft");
  const workItems = takeAllFlags(args, "--work-items");
  const requiredReviewers = takeAllFlags(args, "--required-reviewers");

  const azArgs = [
    "repos",
    "pr",
    "create",
    "--title",
    title,
    "--source-branch",
    sourceBranch,
    "--target-branch",
    targetBranch,
    "--repository",
    repository,
  ];
  if (description !== undefined) azArgs.push("--description", description);
  if (draft) azArgs.push("--draft");
  if (workItems.length > 0) azArgs.push("--work-items", ...workItems);
  if (requiredReviewers.length > 0) azArgs.push("--required-reviewers", ...requiredReviewers);

  const created = await azJson<PrItem>(withOrgProject(azArgs, ctx), {
    operation: "pr create",
    category: "az repos pr create",
  });

  return renderOutput([
    renderDetail("created", created, [
      custom("id", (i: PrItem) => i.pullRequestId),
      field("title"),
      lower("status"),
    ]),
    renderHelp(getSuggestions({ domain: "pr", action: "create", id: created.pullRequestId, ctx })),
  ]);
}

async function prComplete(args: string[], ctx?: AdoContext): Promise<string> {
  const squash = takeBoolFlag(args, "--squash");
  const deleteSourceBranch = takeBoolFlag(args, "--delete-source-branch");
  const bypassPolicy = takeBoolFlag(args, "--bypass-policy");
  const mergeCommitMessage = takeFlag(args, "--merge-commit-message");
  const id = takeNumber(args, "PR");

  const current = await getPullRequest(id, ctx, "pr complete");
  if (current.status === "completed") {
    return renderOutput([
      renderDetail("pull_request", { id, status: "completed", already: true }, [
        custom("id", (i: { id: number }) => i.id),
        custom("status", (i: { status: string }) => i.status),
        custom("already", (i: { already: boolean }) => i.already),
      ]),
      renderHelp(getSuggestions({ domain: "pr", action: "complete", id, ctx })),
    ]);
  }

  const azArgs = ["repos", "pr", "update", "--id", String(id), "--status", "completed"];
  if (squash) azArgs.push("--squash", "true");
  if (deleteSourceBranch) azArgs.push("--delete-source-branch", "true");
  if (bypassPolicy) azArgs.push("--bypass-policy", "true");
  if (mergeCommitMessage) azArgs.push("--merge-commit-message", mergeCommitMessage);

  await azJson<PrItem>(withOrgProject(azArgs, ctx), {
    operation: "pr complete",
    category: "az repos pr update",
  });

  return renderOutput([
    renderDetail("completed", { id, status: "ok" }, [
      custom("id", (i: { id: number }) => i.id),
      custom("status", (i: { status: string }) => i.status),
    ]),
    renderHelp(getSuggestions({ domain: "pr", action: "complete", id, ctx })),
  ]);
}

async function prReview(args: string[], ctx?: AdoContext): Promise<string> {
  const approve = takeBoolFlag(args, "--approve");
  const approveWithSuggestions = takeBoolFlag(args, "--approve-with-suggestions");
  const reject = takeBoolFlag(args, "--reject");
  const wait = takeBoolFlag(args, "--wait");
  const reset = takeBoolFlag(args, "--reset");
  const id = takeNumber(args, "PR");

  const chosen = [approve, approveWithSuggestions, reject, wait, reset].filter(Boolean).length;
  if (chosen !== 1) {
    throw new AxiError(
      "Choose exactly one of: --approve, --approve-with-suggestions, --reject, --wait, --reset",
      "VALIDATION_ERROR",
    );
  }

  const vote = approve
    ? "approve"
    : approveWithSuggestions
      ? "approve-with-suggestions"
      : reject
        ? "reject"
        : wait
          ? "wait-for-author"
          : "reset";

  await azJson(withOrgProject(["repos", "pr", "set-vote", "--id", String(id), "--vote", vote], ctx), {
    operation: "pr review",
    category: "az repos pr set-vote",
  });

  return renderOutput([
    renderDetail("review", { id, vote: voteLabel(voteValue(vote)) }, [
      custom("id", (i: { id: number }) => i.id),
      custom("vote", (i: { vote: string }) => i.vote),
    ]),
    renderHelp(getSuggestions({ domain: "pr", action: "review", id, ctx })),
  ]);
}

async function prReviewers(args: string[], ctx?: AdoContext): Promise<string> {
  const id = takeNumber(args, "PR");

  const result = await azJson<Reviewer[]>(
    withOrgProject(["repos", "pr", "reviewer", "list", "--id", String(id)], ctx),
    { operation: "pr reviewers", category: "az repos pr reviewer list" },
  );
  const reviewers = Array.isArray(result) ? result : [];
  const isEmpty = reviewers.length === 0;

  return renderOutput([
    isEmpty ? "count: 0 reviewers" : `count: ${reviewers.length}`,
    isEmpty ? "" : renderList("reviewers", reviewers, reviewerSchema),
    renderHelp(getSuggestions({ domain: "pr", action: "reviewers", id, isEmpty, ctx })),
  ]);
}

async function prAddReviewer(args: string[], ctx?: AdoContext): Promise<string> {
  const required = takeBoolFlag(args, "--required");
  const id = takeNumber(args, "PR");
  const reviewers = takeAllFlags(args, "--reviewers");
  if (reviewers.length === 0) {
    throw new AxiError("--reviewers is required (repeatable)", "VALIDATION_ERROR", [
      "Pass --reviewers <email> once per reviewer to add",
    ]);
  }

  const azArgs = ["repos", "pr", "reviewer", "add", "--id", String(id), "--reviewers", ...reviewers];
  if (required) azArgs.push("--required", "true");
  await azJson(withOrgProject(azArgs, ctx), {
    operation: "pr add-reviewer",
    category: "az repos pr reviewer add",
  });

  return renderOutput([
    renderDetail("reviewers_added", { id, reviewers: reviewers.join(", "), required }, [
      custom("id", (i: { id: number }) => i.id),
      custom("reviewers", (i: { reviewers: string }) => i.reviewers),
      boolYesNo("required"),
    ]),
    renderHelp(getSuggestions({ domain: "pr", action: "add-reviewer", id, ctx })),
  ]);
}

async function prRemoveReviewer(args: string[], ctx?: AdoContext): Promise<string> {
  const id = takeNumber(args, "PR");
  const reviewers = takeAllFlags(args, "--reviewers");
  if (reviewers.length === 0) {
    throw new AxiError("--reviewers is required (repeatable)", "VALIDATION_ERROR", [
      "Pass --reviewers <email> once per reviewer to remove",
    ]);
  }

  await azJson(
    withOrgProject(
      ["repos", "pr", "reviewer", "remove", "--id", String(id), "--reviewers", ...reviewers],
      ctx,
    ),
    { operation: "pr remove-reviewer", category: "az repos pr reviewer remove" },
  );

  return renderOutput([
    renderDetail("reviewers_removed", { id, reviewers: reviewers.join(", ") }, [
      custom("id", (i: { id: number }) => i.id),
      custom("reviewers", (i: { reviewers: string }) => i.reviewers),
    ]),
    renderHelp(getSuggestions({ domain: "pr", action: "remove-reviewer", id, ctx })),
  ]);
}

async function prWorkItems(args: string[], ctx?: AdoContext): Promise<string> {
  const id = takeNumber(args, "PR");

  const items = await listWorkItems(id, ctx, "pr work-items");
  const isEmpty = items.length === 0;

  return renderOutput([
    isEmpty ? "count: 0 linked work items" : `count: ${items.length}`,
    isEmpty ? "" : renderList("work_items", items as WorkItemRef[], workItemRefSchema),
    renderHelp(getSuggestions({ domain: "pr", action: "work-items", id, isEmpty, ctx })),
  ]);
}

async function prLinkWorkItem(args: string[], ctx?: AdoContext): Promise<string> {
  const id = takeNumber(args, "PR");
  const workItems = takeAllFlags(args, "--work-items");
  if (workItems.length === 0) {
    throw new AxiError("--work-items is required (repeatable)", "VALIDATION_ERROR", [
      "Pass --work-items <id> once per work item to link",
    ]);
  }

  await azJson(
    withOrgProject(
      ["repos", "pr", "work-item", "add", "--id", String(id), "--work-items", ...workItems],
      ctx,
    ),
    { operation: "pr link-work-item", category: "az repos pr work-item add" },
  );

  return renderOutput([
    renderDetail("work_items_linked", { id, workItems: workItems.join(", ") }, [
      custom("id", (i: { id: number }) => i.id),
      custom("work_items", (i: { workItems: string }) => i.workItems),
    ]),
    renderHelp(getSuggestions({ domain: "pr", action: "link-work-item", id, ctx })),
  ]);
}

async function prUnlinkWorkItem(args: string[], ctx?: AdoContext): Promise<string> {
  const id = takeNumber(args, "PR");
  const workItems = takeAllFlags(args, "--work-items");
  if (workItems.length === 0) {
    throw new AxiError("--work-items is required (repeatable)", "VALIDATION_ERROR", [
      "Pass --work-items <id> once per work item to unlink",
    ]);
  }

  await azJson(
    withOrgProject(
      ["repos", "pr", "work-item", "remove", "--id", String(id), "--work-items", ...workItems],
      ctx,
    ),
    { operation: "pr unlink-work-item", category: "az repos pr work-item remove" },
  );

  return renderOutput([
    renderDetail("work_items_unlinked", { id, workItems: workItems.join(", ") }, [
      custom("id", (i: { id: number }) => i.id),
      custom("work_items", (i: { workItems: string }) => i.workItems),
    ]),
    renderHelp(getSuggestions({ domain: "pr", action: "unlink-work-item", id, ctx })),
  ]);
}

function voteValue(vote: string): number {
  switch (vote) {
    case "approve":
      return 10;
    case "approve-with-suggestions":
      return 5;
    case "reject":
      return -10;
    case "wait-for-author":
      return -5;
    default:
      return 0;
  }
}

export async function prCommand(args: string[], ctx?: AdoContext): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list":
      return prList(rest, ctx);
    case "view":
      return prView(rest, ctx);
    case "inspect":
      return prInspect(rest, ctx);
    case "create":
      return prCreate(rest, ctx);
    case "update":
      return prUpdate(rest, ctx);
    case "comment":
      return prComment(rest, ctx);
    case "threads":
      return prThreads(rest, ctx);
    case "thread":
      return prThread(rest, ctx);
    case "checks":
      return prChecks(rest, ctx);
    case "commits":
      return prCommits(rest, ctx);
    case "files":
      return prFiles(rest, ctx);
    case "complete":
      return prComplete(rest, ctx);
    case "review":
      return prReview(rest, ctx);
    case "reviewers":
      return prReviewers(rest, ctx);
    case "add-reviewer":
      return prAddReviewer(rest, ctx);
    case "remove-reviewer":
      return prRemoveReviewer(rest, ctx);
    case "work-items":
      return prWorkItems(rest, ctx);
    case "link-work-item":
      return prLinkWorkItem(rest, ctx);
    case "unlink-work-item":
      return prUnlinkWorkItem(rest, ctx);
    case "--help":
    case "-h":
    case "help":
    case undefined:
      return PR_HELP;
    default:
      throw new AxiError(`Unknown pr subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `ado-axi pr --help` to see available subcommands",
      ]);
  }
}
