/**
 * Azure DevOps response shapes, narrowed to the fields ado-axi actually reads.
 * Every field is optional because Azure omits rather than nulls absent data.
 */

export interface IdentityRef {
  id?: string;
  displayName?: string;
  uniqueName?: string;
  isContainer?: boolean;
}

export interface ReviewerRef extends IdentityRef {
  vote?: number;
  isRequired?: boolean;
  isFlagged?: boolean;
  hasDeclined?: boolean;
}

export interface TeamProjectRef {
  id?: string;
  name?: string;
}

export interface RepositoryRef {
  id?: string;
  name?: string;
  project?: TeamProjectRef;
  webUrl?: string;
  defaultBranch?: string;
}

export interface PullRequest {
  pullRequestId: number;
  codeReviewId?: number;
  title?: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  createdBy?: IdentityRef;
  creationDate?: string;
  closedDate?: string;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: string;
  mergeId?: string;
  reviewers?: ReviewerRef[];
  repository?: RepositoryRef;
  url?: string;
  labels?: Array<{ name?: string; active?: boolean }>;
  lastMergeSourceCommit?: { commitId?: string };
  lastMergeTargetCommit?: { commitId?: string };
}

/** Fields accepted by a PR PATCH. Only keys present in the object are sent. */
export interface PullRequestPatch {
  title?: string;
  description?: string;
  isDraft?: boolean;
  status?: "active" | "abandoned" | "completed";
  targetRefName?: string;
  /** Azure rejects source-branch changes; kept here so the client can say so precisely. */
  sourceRefName?: string;
}

export interface CommentRef {
  id?: number;
  parentCommentId?: number;
  author?: IdentityRef;
  content?: string;
  publishedDate?: string;
  lastUpdatedDate?: string;
  commentType?: string;
  isDeleted?: boolean;
}

export interface ThreadFilePosition {
  line?: number;
  offset?: number;
}

export interface ThreadContext {
  filePath?: string;
  rightFileStart?: ThreadFilePosition;
  rightFileEnd?: ThreadFilePosition;
  leftFileStart?: ThreadFilePosition;
  leftFileEnd?: ThreadFilePosition;
}

export interface CommentThread {
  id?: number;
  status?: string;
  publishedDate?: string;
  lastUpdatedDate?: string;
  comments?: CommentRef[];
  threadContext?: ThreadContext;
  isDeleted?: boolean;
  properties?: Record<string, unknown>;
}

export interface PullRequestStatus {
  id?: number;
  state?: string;
  description?: string;
  context?: { name?: string; genre?: string };
  targetUrl?: string;
  creationDate?: string;
}

export interface PolicyEvaluation {
  evaluationId?: string;
  status?: string;
  startedDate?: string;
  completedDate?: string;
  configuration?: {
    id?: number;
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { id?: string; displayName?: string };
    settings?: Record<string, unknown>;
  };
  context?: Record<string, unknown>;
}

export interface GitCommitRef {
  commitId?: string;
  comment?: string;
  author?: { name?: string; email?: string; date?: string };
  committer?: { name?: string; email?: string; date?: string };
}

export interface GitChangeItem {
  changeType?: string;
  item?: { path?: string; isFolder?: boolean; gitObjectType?: string };
}

export interface PullRequestIteration {
  id?: number;
  createdDate?: string;
  description?: string;
}

export interface WorkItemRefLite {
  id?: string | number;
  url?: string;
}

/** Azure's numeric vote scale, as a stable label. */
export const VOTE_LABELS: Record<number, string> = {
  10: "approved",
  5: "approved_with_suggestions",
  0: "no_vote",
  [-5]: "waiting_for_author",
  [-10]: "rejected",
};

/**
 * Thread statuses Azure considers still needing attention. Anything else
 * (fixed, wontFix, closed, byDesign) counts as resolved.
 */
const UNRESOLVED_THREAD_STATUSES: ReadonlySet<string> = new Set(["active", "pending", "unknown"]);

export function isThreadUnresolved(status: string | undefined): boolean {
  return UNRESOLVED_THREAD_STATUSES.has((status ?? "unknown").toLowerCase());
}

/** Thread statuses accepted by `pr thread resolve --status`. */
export const THREAD_STATUSES = [
  "active",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
  "pending",
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export function normalizeThreadStatus(value: string): ThreadStatus | undefined {
  const match = THREAD_STATUSES.find((s) => s.toLowerCase() === value.toLowerCase());
  return match;
}
