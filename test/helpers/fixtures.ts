/**
 * Fixtures modelled on the real `AI.IOS.Web` PR 2613 workflow that this feature
 * set was built for - including the exact SonarQube finding that surfaced there.
 */

export const EM_DASH = "—";
export const INFINITY = "∞";

export const PR_DESCRIPTION = [
  `## Summary ${EM_DASH} upload validation hardening`,
  "",
  `Replaces \`charCodeAt\` with \`codePointAt\` so astral-plane filenames survive validation ${EM_DASH} including names from non-Latin scripts such as 日本語.`,
  "",
  "```ts",
  "const point = name.codePointAt(index);",
  "```",
].join("\n");

export const SONAR_COMMENT = [
  "Prefer String#codePointAt() over String#charCodeAt().",
  "Rule: typescript:S7758",
].join("\n");

export const pullRequest = {
  pullRequestId: 2613,
  codeReviewId: 2613,
  title: `Harden upload validation ${EM_DASH} codePointAt`,
  description: PR_DESCRIPTION,
  status: "active",
  isDraft: false,
  createdBy: { displayName: "Renée Müller", uniqueName: "renee@contoso.com" },
  creationDate: "2026-08-01T09:00:00Z",
  sourceRefName: "refs/heads/feature/upload-validation",
  targetRefName: "refs/heads/main",
  mergeStatus: "succeeded",
  reviewers: [
    { displayName: "Ada Lovelace", uniqueName: "ada@contoso.com", vote: 10, isRequired: true },
    { displayName: "Grace Hopper", uniqueName: "grace@contoso.com", vote: -5, isRequired: false },
  ],
  repository: {
    id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    name: "AI.IOS.Web",
    project: { id: "9a8b7c6d-5e4f-4321-9876-0a1b2c3d4e5f", name: "AI" },
  },
};

export const threads = {
  value: [
    {
      id: 98765,
      status: "active",
      publishedDate: "2026-08-02T11:15:00Z",
      threadContext: {
        filePath: "/app/lib/files/upload-validation.ts",
        rightFileStart: { line: 421, offset: 5 },
        rightFileEnd: { line: 421, offset: 40 },
      },
      comments: [
        {
          id: 1,
          author: { displayName: "DevOpsCodeScan", uniqueName: "codescan@contoso.com" },
          content: SONAR_COMMENT,
          publishedDate: "2026-08-02T11:15:00Z",
          commentType: "text",
        },
      ],
    },
    {
      id: 98766,
      status: "fixed",
      publishedDate: "2026-08-02T12:00:00Z",
      threadContext: {
        filePath: "/app/lib/files/upload-validation.ts",
        rightFileStart: { line: 88, offset: 1 },
        rightFileEnd: { line: 92, offset: 1 },
      },
      comments: [
        {
          id: 1,
          author: { displayName: "Ada Lovelace", uniqueName: "ada@contoso.com" },
          content: `The retry budget here is effectively ${INFINITY} ${EM_DASH} please cap it.`,
          publishedDate: "2026-08-02T12:00:00Z",
          commentType: "text",
        },
        {
          id: 2,
          parentCommentId: 1,
          author: { displayName: "Renée Müller", uniqueName: "renee@contoso.com" },
          content: "Capped at 5 retries in the latest push.",
          publishedDate: "2026-08-02T12:30:00Z",
          commentType: "text",
        },
      ],
    },
    {
      id: 98767,
      status: "closed",
      publishedDate: "2026-08-02T12:45:00Z",
      comments: [
        {
          id: 1,
          author: { displayName: "Azure DevOps" },
          content: "Ada Lovelace voted 10",
          publishedDate: "2026-08-02T12:45:00Z",
          commentType: "system",
        },
      ],
    },
  ],
};

export const statuses = {
  value: [
    {
      id: 1,
      state: "succeeded",
      description: "Build succeeded",
      context: { genre: "continuous-integration", name: "ios-web-ci" },
      targetUrl: "https://dev.azure.com/contoso/AI/_build/results?buildId=9001",
      creationDate: "2026-08-02T10:00:00Z",
    },
    {
      id: 2,
      state: "failed",
      description: `Code coverage dropped ${EM_DASH} 71% of 80% required`,
      context: { genre: "quality", name: "sonarqube" },
      creationDate: "2026-08-02T10:05:00Z",
    },
  ],
};

export const policyEvaluations = {
  value: [
    {
      evaluationId: "e1",
      status: "approved",
      completedDate: "2026-08-02T10:10:00Z",
      configuration: { id: 5, isBlocking: true, type: { displayName: "Minimum number of reviewers" } },
    },
    {
      evaluationId: "e2",
      status: "rejected",
      completedDate: "2026-08-02T10:11:00Z",
      configuration: { id: 6, isBlocking: true, type: { displayName: "Build validation" } },
    },
  ],
};

/** Two pages, so the continuation-token path is exercised. */
export const commitsPageOne = {
  value: [
    {
      commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      comment: `Use codePointAt ${EM_DASH} fixes S7758`,
      author: { name: "Renée Müller", date: "2026-08-01T09:10:00Z" },
    },
  ],
  continuationToken: "page2",
};

export const commitsPageTwo = {
  value: [
    {
      commitId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      comment: "Cap retry budget at 5",
      author: { name: "Renée Müller", date: "2026-08-02T13:00:00Z" },
    },
  ],
};

export const iterations = {
  value: [
    { id: 1, createdDate: "2026-08-01T09:10:00Z" },
    { id: 2, createdDate: "2026-08-02T13:00:00Z" },
  ],
};

export const iterationChanges = {
  value: [
    { changeType: "edit", item: { path: "/app/lib/files/upload-validation.ts" } },
    { changeType: "add", item: { path: "/app/lib/files/__tests__/upload-validation.test.ts" } },
    { changeType: "edit", item: { path: "/app/lib/files", isFolder: true } },
  ],
};

export const linkedWorkItems = [
  { id: 16048, url: "https://dev.azure.com/contoso/AI/_apis/wit/workItems/16048" },
];

/** The happy-path route table for a full `pr inspect`. */
export function inspectRoutes(overrides: Record<string, unknown> = {}) {
  return {
    "repos pr show": { json: pullRequest },
    "rest GET git/pullRequestThreads": { json: threads },
    "rest GET git/pullRequestStatuses": { json: statuses },
    "rest GET policy/evaluations": { json: policyEvaluations },
    "rest GET git/pullRequestCommits": (_args: string[], call: number) => ({
      json: call === 0 ? commitsPageOne : commitsPageTwo,
    }),
    "rest GET git/pullRequestIterations": { json: iterations },
    "rest GET git/pullRequestIterationChanges": { json: iterationChanges },
    "repos pr work-item list": { json: linkedWorkItems },
    ...overrides,
  };
}
