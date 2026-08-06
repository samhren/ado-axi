import { truncateBody } from "../format.js";
import {
  isThreadUnresolved,
  VOTE_LABELS,
  type CommentThread,
  type GitChangeItem,
  type GitCommitRef,
  type IdentityRef,
  type PolicyEvaluation,
  type PullRequest,
  type PullRequestStatus,
  type ReviewerRef,
  type WorkItemRefLite,
} from "../api/types.js";

/**
 * Bots that post automated code-scan findings. Their threads are the ones an
 * agent almost always wants first, so `pr inspect` calls them out separately
 * instead of burying them among human review comments.
 */
export const CODE_SCAN_AUTHOR = /devopscodescan|sonar|codescan/i;

export function branchName(ref: string | undefined): string {
  return (ref ?? "").replace(/^refs\/heads\//, "");
}

export function toRefName(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function personName(person: IdentityRef | undefined): string {
  return person?.displayName ?? person?.uniqueName ?? "unknown";
}

export function voteLabel(vote: number | undefined): string {
  return VOTE_LABELS[vote ?? 0] ?? "no_vote";
}

/** Body text honouring --full: complete when asked for, truncated with a hint otherwise. */
export function bodyText(text: string | undefined, full: boolean): string {
  if (!text) return "";
  return full ? text : truncateBody(text);
}

export interface CommentView {
  id: number | null;
  author: string;
  published: string;
  updated: string;
  type: string;
  text: string;
}

export interface ThreadView {
  thread: number | null;
  status: string;
  resolved: string;
  file: string;
  lines: string;
  author: string;
  published: string;
  code_scan: string;
  comments: CommentView[];
}

/** Line range of an inline comment, e.g. "421" or "421-425"; empty for PR-level threads. */
export function threadLines(thread: CommentThread): string {
  const context = thread.threadContext;
  const start = context?.rightFileStart?.line ?? context?.leftFileStart?.line;
  if (start === undefined) return "";
  const end = context?.rightFileEnd?.line ?? context?.leftFileEnd?.line ?? start;
  return end > start ? `${start}-${end}` : String(start);
}

/** True when a thread carries only Azure-generated activity (votes, status changes, policy noise). */
export function isSystemThread(thread: CommentThread): boolean {
  const comments = (thread.comments ?? []).filter((c) => !c.isDeleted);
  if (comments.length === 0) return true;
  return comments.every((c) => (c.commentType ?? "text").toLowerCase() === "system");
}

export function isCodeScanThread(thread: CommentThread): boolean {
  return (thread.comments ?? []).some((c) => CODE_SCAN_AUTHOR.test(personName(c.author)));
}

export function toThreadView(thread: CommentThread, full: boolean): ThreadView {
  const comments = (thread.comments ?? []).filter((c) => !c.isDeleted);
  const status = (thread.status ?? "unknown").toLowerCase();
  return {
    thread: thread.id ?? null,
    status,
    resolved: isThreadUnresolved(status) ? "no" : "yes",
    file: thread.threadContext?.filePath ?? "",
    lines: threadLines(thread),
    author: personName(comments[0]?.author),
    published: String(thread.publishedDate ?? comments[0]?.publishedDate ?? ""),
    code_scan: isCodeScanThread(thread) ? "yes" : "no",
    comments: comments.map((comment) => ({
      id: comment.id ?? null,
      author: personName(comment.author),
      published: String(comment.publishedDate ?? ""),
      updated: String(comment.lastUpdatedDate ?? comment.publishedDate ?? ""),
      type: (comment.commentType ?? "text").toLowerCase(),
      text: bodyText(comment.content, full),
    })),
  };
}

export interface ThreadFilter {
  unresolvedOnly?: boolean;
  author?: string;
  includeSystem?: boolean;
  codeScanOnly?: boolean;
}

export function filterThreads(
  threads: CommentThread[],
  filter: ThreadFilter,
): CommentThread[] {
  return threads.filter((thread) => {
    if (thread.isDeleted) return false;
    if (!filter.includeSystem && isSystemThread(thread)) return false;
    if (filter.unresolvedOnly && !isThreadUnresolved(thread.status)) return false;
    if (filter.codeScanOnly && !isCodeScanThread(thread)) return false;
    if (filter.author) {
      const needle = filter.author.toLowerCase();
      const matches = (thread.comments ?? []).some((c) => {
        const author = c.author;
        return (
          (author?.displayName ?? "").toLowerCase().includes(needle) ||
          (author?.uniqueName ?? "").toLowerCase().includes(needle)
        );
      });
      if (!matches) return false;
    }
    return true;
  });
}

export interface CheckView {
  check: string;
  state: string;
  description: string;
  url: string;
  created: string;
}

export function toCheckViews(statuses: PullRequestStatus[]): CheckView[] {
  return statuses.map((status) => ({
    check: [status.context?.genre, status.context?.name].filter(Boolean).join("/") || "unnamed",
    state: (status.state ?? "notSet").toLowerCase(),
    description: status.description ?? "",
    url: status.targetUrl ?? "",
    created: String(status.creationDate ?? ""),
  }));
}

export interface PolicyView {
  policy: string;
  status: string;
  blocking: string;
  completed: string;
}

export function toPolicyViews(evaluations: PolicyEvaluation[]): PolicyView[] {
  return evaluations.map((evaluation) => ({
    policy: evaluation.configuration?.type?.displayName ?? "unknown policy",
    status: (evaluation.status ?? "unknown").toLowerCase(),
    blocking: evaluation.configuration?.isBlocking ? "yes" : "no",
    completed: String(evaluation.completedDate ?? ""),
  }));
}

/** Pass/fail rollup so a caller does not have to count rows itself. */
export function checkSummary(checks: CheckView[], policies: PolicyView[]): string {
  const succeeded = checks.filter((c) => c.state === "succeeded").length;
  const failed = checks.filter((c) => c.state === "failed" || c.state === "error").length;
  const pending = checks.length - succeeded - failed;
  const blockingUnmet = policies.filter(
    (p) => p.blocking === "yes" && p.status !== "approved",
  ).length;

  const parts = [`${succeeded} succeeded`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} pending`);
  parts.push(`${blockingUnmet} blocking ${blockingUnmet === 1 ? "policy" : "policies"} unmet`);
  return parts.join(", ");
}

export interface CodeScanFinding {
  thread: number | null;
  author: string;
  file: string;
  lines: string;
  resolved: string;
}

/**
 * A compact index of automated code-scan threads. The full text already appears
 * once under `threads`, so this points at it rather than repeating it.
 */
export function toCodeScanFindings(threads: ThreadView[]): CodeScanFinding[] {
  return threads
    .filter((thread) => thread.code_scan === "yes")
    .map((thread) => ({
      thread: thread.thread,
      author: thread.author,
      file: thread.file,
      lines: thread.lines,
      resolved: thread.resolved,
    }));
}

export interface CommitView {
  commit: string;
  author: string;
  date: string;
  message: string;
}

export function toCommitViews(commits: GitCommitRef[]): CommitView[] {
  return commits.map((commit) => ({
    commit: (commit.commitId ?? "").slice(0, 10),
    author: commit.author?.name ?? commit.committer?.name ?? "unknown",
    date: String(commit.author?.date ?? commit.committer?.date ?? ""),
    message: (commit.comment ?? "").split("\n")[0],
  }));
}

export interface FileView {
  change: string;
  path: string;
}

export function toFileViews(changes: GitChangeItem[]): FileView[] {
  return changes
    .filter((change) => !change.item?.isFolder)
    .map((change) => ({
      change: (change.changeType ?? "edit").toLowerCase(),
      path: change.item?.path ?? "",
    }));
}

export interface ReviewerView {
  reviewer: string;
  vote: string;
  required: string;
}

export function toReviewerViews(reviewers: ReviewerRef[] | undefined): ReviewerView[] {
  return (reviewers ?? []).map((reviewer) => ({
    reviewer: personName(reviewer),
    vote: voteLabel(reviewer.vote),
    required: reviewer.isRequired ? "yes" : "no",
  }));
}

export function reviewSummary(reviewers: ReviewerRef[] | undefined): string {
  if (!reviewers || reviewers.length === 0) return "no reviewers";
  const counts = { approved: 0, waiting: 0, rejected: 0, pending: 0 };
  for (const reviewer of reviewers) {
    const vote = reviewer.vote ?? 0;
    if (vote >= 5) counts.approved++;
    else if (vote === -5) counts.waiting++;
    else if (vote === -10) counts.rejected++;
    else counts.pending++;
  }
  const parts = [`${counts.approved} approved`];
  if (counts.rejected > 0) parts.push(`${counts.rejected} rejected`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  return parts.join(", ");
}

export function toWorkItemViews(
  workItems: WorkItemRefLite[],
): Array<{ id: string; url: string }> {
  return workItems.map((item) => ({ id: String(item.id ?? ""), url: item.url ?? "" }));
}

/** The header block shared by `pr inspect` and `pr view`. */
export function toPullRequestView(
  pr: PullRequest,
  full: boolean,
): Record<string, unknown> {
  return {
    id: pr.pullRequestId,
    title: pr.title ?? "",
    status: (pr.status ?? "").toLowerCase(),
    draft: pr.isDraft ? "yes" : "no",
    author: personName(pr.createdBy),
    created: String(pr.creationDate ?? ""),
    source: branchName(pr.sourceRefName),
    target: branchName(pr.targetRefName),
    repository: pr.repository?.name ?? "",
    project: pr.repository?.project?.name ?? "",
    merge_status: (pr.mergeStatus ?? "unknown").toLowerCase(),
    reviewers: reviewSummary(pr.reviewers),
    description: bodyText(pr.description, full),
  };
}
