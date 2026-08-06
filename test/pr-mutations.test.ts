import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { clearRepositoryCache } from "../src/api/repository.js";
import { createAzMock, createStdout, type AzMock } from "./helpers/az-mock.js";
import { EM_DASH, INFINITY, SONAR_COMMENT, inspectRoutes, pullRequest, threads } from "./helpers/fixtures.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("no git repo");
  }),
}));

const mockedExecFile = vi.mocked(execFile);
const workdir = mkdtempSync(join(tmpdir(), "ado-axi-test-"));

function install(routes: Record<string, unknown>): AzMock {
  const mock = createAzMock(routes as Parameters<typeof createAzMock>[0]);
  mockedExecFile.mockImplementation(
    mock.implementation as unknown as typeof mockedExecFile.getMockImplementation,
  );
  return mock;
}

async function run(argv: string[]): Promise<string> {
  const output = createStdout();
  await main({ argv, stdout: output.stdout });
  return output.read();
}

const NEW_DESCRIPTION = [
  `## Summary ${EM_DASH} rewritten`,
  "",
  `Retry budget is no longer ${INFINITY}; it is capped at 5.`,
  "",
  "```ts",
  "const retries = Math.min(configured, 5);",
  "```",
].join("\n");

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("pr update", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    clearRepositoryCache();
    process.exitCode = undefined;
  });

  it("--dry-run shows the intended change and sends nothing to Azure DevOps", async () => {
    const path = join(workdir, "description.md");
    writeFileSync(path, NEW_DESCRIPTION, "utf-8");

    const mock = install({ "repos pr show": { json: pullRequest } });
    const rendered = await run(["pr", "update", "2613", "--description-file", path, "--dry-run"]);

    expect(rendered).toContain("dry_run");
    expect(rendered).toContain("id: 2613");
    expect(rendered).toContain("fields: description");
    expect(rendered).toContain("applied: no");
    expect(rendered).toContain("no request was sent to Azure DevOps");
    expect(rendered).toContain("rewritten");

    // Read-only: the PR was fetched to build the diff, and nothing was written.
    expect(mock.countFor("repos pr show")).toBe(1);
    expect(mock.countFor("rest PATCH git/pullRequests")).toBe(0);
    expect(mock.calls.every((call) => !call.args.includes("PATCH"))).toBe(true);
  });

  it("PATCHes only the supplied field and verifies the result by re-fetching", async () => {
    const path = join(workdir, "description.md");
    writeFileSync(path, NEW_DESCRIPTION, "utf-8");

    const updated = { ...pullRequest, description: NEW_DESCRIPTION };
    const mock = install({
      "repos pr show": (_args, call) => ({ json: call === 0 ? pullRequest : updated }),
      "rest PATCH git/pullRequests": { json: updated },
    });

    const rendered = await run(["pr", "update", "2613", "--description-file", path]);

    const patch = mock.callsFor("rest PATCH git/pullRequests")[0];
    expect(patch.body).toEqual({ description: NEW_DESCRIPTION });
    // Nothing else was touched - title, draft state and branches are absent from the body.
    expect(Object.keys(patch.body as object)).toEqual(["description"]);

    // Verified against a fresh read, not the PATCH response.
    expect(mock.countFor("repos pr show")).toBe(2);
    expect(rendered).toContain("updated");
    expect(rendered).toContain("fields: description");
    expect(rendered).toContain("verified: yes");
  });

  it("keeps non-ASCII text byte-identical through the request body", async () => {
    const path = join(workdir, "unicode.md");
    writeFileSync(path, NEW_DESCRIPTION, "utf-8");

    const updated = { ...pullRequest, description: NEW_DESCRIPTION };
    const mock = install({
      "repos pr show": (_args, call) => ({ json: call === 0 ? pullRequest : updated }),
      "rest PATCH git/pullRequests": { json: updated },
    });
    await run(["pr", "update", "2613", "--description-file", path]);

    const body = mock.callsFor("rest PATCH git/pullRequests")[0].body as { description: string };
    expect(body.description).toBe(NEW_DESCRIPTION);
    expect(body.description).toContain(EM_DASH);
    expect(body.description).toContain(INFINITY);
    expect(body.description).not.toContain("�");
  });

  it("sends multiple named fields together and reports verification per field", async () => {
    const updated = { ...pullRequest, title: "New title", isDraft: true };
    const mock = install({
      "repos pr show": (_args, call) => ({ json: call === 0 ? pullRequest : updated }),
      "rest PATCH git/pullRequests": { json: updated },
    });

    const rendered = await run(["pr", "update", "2613", "--title", "New title", "--draft"]);

    expect(mock.callsFor("rest PATCH git/pullRequests")[0].body).toEqual({
      title: "New title",
      isDraft: true,
    });
    expect(rendered).toContain('fields: "title, isDraft"');
    expect(rendered).toContain("verified: yes");
  });

  it("reports verified: no when Azure did not apply the change", async () => {
    const mock = install({
      "repos pr show": { json: pullRequest },
      "rest PATCH git/pullRequests": { json: pullRequest },
    });

    const rendered = await run(["pr", "update", "2613", "--title", "New title"]);

    expect(mock.countFor("rest PATCH git/pullRequests")).toBe(1);
    expect(rendered).toContain("verified: no");
  });

  it("never sends --project to `az repos pr show`, which does not accept it", async () => {
    const mock = install({
      "repos pr show": { json: pullRequest },
      "rest PATCH git/pullRequests": { json: pullRequest },
    });
    await run(["pr", "update", "2613", "--title", "x", "--project", "AI", "--org", "contoso"]);

    for (const call of mock.callsFor("repos pr show")) {
      expect(call.args).not.toContain("--project");
      expect(call.args).toContain("--organization");
    }
  });

  it("rejects a source-branch change instead of silently dropping it", async () => {
    install({ "repos pr show": { json: pullRequest } });
    const rendered = await run(["pr", "update", "2613", "--source-branch", "other"]);

    expect(process.exitCode).toBe(2);
    expect(rendered).toContain("does not allow changing a pull request's source branch");
    expect(rendered).toContain("--target-branch");
  });

  it("requires at least one field", async () => {
    install({ "repos pr show": { json: pullRequest } });
    const rendered = await run(["pr", "update", "2613"]);

    expect(process.exitCode).toBe(2);
    expect(rendered).toContain("Nothing to update");
  });

  it("retargets a PR by converting a branch name to a ref", async () => {
    const updated = { ...pullRequest, targetRefName: "refs/heads/release" };
    const mock = install({
      "repos pr show": (_args, call) => ({ json: call === 0 ? pullRequest : updated }),
      "rest PATCH git/pullRequests": { json: updated },
    });
    await run(["pr", "update", "2613", "--target-branch", "release"]);

    expect(mock.callsFor("rest PATCH git/pullRequests")[0].body).toEqual({
      targetRefName: "refs/heads/release",
    });
  });
});

describe("pr threads", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    clearRepositoryCache();
    process.exitCode = undefined;
  });

  it("--unresolved returns the SonarQube finding with author, file, line, and exact text", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "threads", "2613", "--unresolved"]);

    expect(rendered).toContain("count: 1 unresolved review threads");
    expect(rendered).toContain("DevOpsCodeScan");
    expect(rendered).toContain("/app/lib/files/upload-validation.ts");
    expect(rendered).toContain("lines: \"421\"");
    expect(rendered).toContain("Prefer String#codePointAt() over String#charCodeAt().");
    expect(rendered).toContain("typescript:S7758");
    expect(rendered).toContain("resolved: no");
    expect(rendered).not.toContain("�");
  });

  it("shows resolved threads, with their replies, when --unresolved is not passed", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "threads", "2613"]);

    expect(rendered).toContain("count: 2 review threads");
    expect(rendered).toContain("status: fixed");
    expect(rendered).toContain("resolved: yes");
    expect(rendered).toContain("lines: 88-92");
    expect(rendered).toContain(INFINITY);
    // The reply on the resolved thread is present too.
    expect(rendered).toContain("Capped at 5 retries in the latest push.");
  });

  it("hides Azure-generated system threads unless --include-system is passed", async () => {
    install(inspectRoutes());
    const withoutSystem = await run(["pr", "threads", "2613"]);
    expect(withoutSystem).not.toContain("Ada Lovelace voted 10");

    mockedExecFile.mockReset();
    clearRepositoryCache();
    install(inspectRoutes());
    const withSystem = await run(["pr", "threads", "2613", "--include-system"]);
    expect(withSystem).toContain("Ada Lovelace voted 10");
  });

  it("filters by author", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "threads", "2613", "--author", "devopscodescan"]);

    expect(rendered).toContain("count: 1 review threads");
    expect(rendered).toContain("DevOpsCodeScan");
    expect(rendered).not.toContain("Capped at 5 retries");
  });

  it("--code-scan narrows to automated findings only", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "threads", "2613", "--code-scan"]);

    expect(rendered).toContain("count: 1 review threads");
    expect(rendered).toContain("typescript:S7758");
  });

  it("--json preserves the exact comment text", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "threads", "2613", "--json"]);
    const parsed = JSON.parse(rendered) as {
      threads: Array<{ comments: Array<{ content: string }> }>;
    };

    expect(parsed.threads[0].comments[0].content).toBe(SONAR_COMMENT);
    expect(parsed.threads[1].comments[0].content).toContain(INFINITY);
  });

  it("`pr thread list` is recognized and behaves like `pr threads`", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "thread", "list", "2613", "--unresolved"]);

    expect(process.exitCode).toBeUndefined();
    expect(rendered).toContain("count: 1 unresolved review threads");
    expect(rendered).toContain("DevOpsCodeScan");
  });

  it("reports a definitive empty state when nothing matches", async () => {
    install(inspectRoutes({ "rest GET git/pullRequestThreads": { json: { value: [] } } }));
    const rendered = await run(["pr", "threads", "2613", "--unresolved"]);

    expect(rendered).toContain("count: 0 unresolved review threads");
  });
});

describe("pr thread resolve", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    clearRepositoryCache();
    process.exitCode = undefined;
  });

  it("closes an open thread and confirms the new status", async () => {
    const mock = install({
      ...inspectRoutes(),
      "rest PATCH git/pullRequestThreads": { json: { id: 98765, status: "closed" } },
    });

    const rendered = await run(["pr", "thread", "resolve", "2613", "--thread-id", "98765"]);

    const patch = mock.callsFor("rest PATCH git/pullRequestThreads")[0];
    expect(patch.body).toEqual({ status: "closed" });
    expect(patch.args.join(" ")).toContain("threadId=98765");
    expect(rendered).toContain("thread: 98765");
    expect(rendered).toContain("status: closed");
    expect(rendered).toContain("resolved: yes");
  });

  it("is idempotent: a thread already in the target status is a no-op with exit 0", async () => {
    const mock = install(inspectRoutes());
    const rendered = await run([
      "pr",
      "thread",
      "resolve",
      "2613",
      "--thread-id",
      "98766",
      "--status",
      "fixed",
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(rendered).toContain("already: true");
    expect(mock.countFor("rest PATCH git/pullRequestThreads")).toBe(0);
  });

  it("rejects an unknown thread id with the ids to look at", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "thread", "resolve", "2613", "--thread-id", "1"]);

    expect(process.exitCode).toBe(1);
    expect(rendered).toContain("Thread 1 does not exist");
    expect(rendered).toContain("ado-axi pr threads 2613");
  });

  it("requires --thread-id", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "thread", "resolve", "2613"]);

    expect(process.exitCode).toBe(2);
    expect(rendered).toContain("--thread-id is required");
  });
});

describe("pr comment", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    clearRepositoryCache();
    process.exitCode = undefined;
  });

  it("opens a new thread with the exact text supplied", async () => {
    const mock = install({
      ...inspectRoutes(),
      "rest POST git/pullRequestThreads": { json: { id: 99001 } },
    });

    const rendered = await run([
      "pr",
      "comment",
      "2613",
      "--description",
      `Capped the retry budget ${EM_DASH} no longer ${INFINITY}`,
    ]);

    const body = mock.callsFor("rest POST git/pullRequestThreads")[0].body as {
      comments: Array<{ content: string }>;
      status: number;
    };
    expect(body.comments[0].content).toBe(`Capped the retry budget ${EM_DASH} no longer ${INFINITY}`);
    expect(body.status).toBe(1);
    expect(rendered).toContain("thread: 99001");
    expect(rendered).toContain("reply: no");
  });

  it("anchors an inline comment to a file and line", async () => {
    const mock = install({
      ...inspectRoutes(),
      "rest POST git/pullRequestThreads": { json: { id: 99002 } },
    });

    await run([
      "pr",
      "comment",
      "2613",
      "--description",
      "Please use codePointAt here",
      "--file",
      "/app/lib/files/upload-validation.ts",
      "--line",
      "421",
    ]);

    const body = mock.callsFor("rest POST git/pullRequestThreads")[0].body as {
      threadContext: { filePath: string; rightFileStart: { line: number } };
    };
    expect(body.threadContext.filePath).toBe("/app/lib/files/upload-validation.ts");
    expect(body.threadContext.rightFileStart.line).toBe(421);
  });

  it("replies to an existing thread when --thread-id is given", async () => {
    const mock = install({
      ...inspectRoutes(),
      "rest POST git/pullRequestThreadComments": { json: { id: 3 } },
    });

    const rendered = await run([
      "pr",
      "thread",
      "reply",
      "2613",
      "--thread-id",
      "98765",
      "--description",
      "Fixed in the latest push",
    ]);

    const call = mock.callsFor("rest POST git/pullRequestThreadComments")[0];
    expect(call.args.join(" ")).toContain("threadId=98765");
    expect((call.body as { content: string }).content).toBe("Fixed in the latest push");
    expect(rendered).toContain("reply: yes");
  });

  it("rejects --line without --file", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "comment", "2613", "--description", "x", "--line", "1"]);

    expect(process.exitCode).toBe(2);
    expect(rendered).toContain("--line requires --file");
  });
});

describe("pr checks", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    clearRepositoryCache();
    process.exitCode = undefined;
  });

  it("summarizes build statuses and policy evaluations", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "checks", "2613"]);

    expect(rendered).toContain("summary: 1 succeeded, 1 failed, 1 blocking policy unmet");
    expect(rendered).toContain("continuous-integration/ios-web-ci");
    expect(rendered).toContain("Build validation");
    expect(rendered).toContain("rejected");
  });

  it("--json returns the raw Azure payloads", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "checks", "2613", "--json"]);
    const parsed = JSON.parse(rendered) as {
      checks: unknown[];
      policy_evaluations: unknown[];
    };

    expect(parsed.checks).toHaveLength(2);
    expect(parsed.policy_evaluations).toHaveLength(2);
  });
});

describe("pr files and commits", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    clearRepositoryCache();
    process.exitCode = undefined;
  });

  it("lists changed files from the latest iteration, skipping folders", async () => {
    const mock = install(inspectRoutes());
    const rendered = await run(["pr", "files", "2613"]);

    // Iteration 2 is the latest, so that is the diff that gets listed.
    expect(mock.callsFor("rest GET git/pullRequestIterationChanges")[0].args.join(" ")).toContain(
      "iterationId=2",
    );
    expect(rendered).toContain("count: 2");
    expect(rendered).toContain("/app/lib/files/upload-validation.ts");
    expect(rendered).not.toContain("edit,/app/lib/files\n");
  });

  it("lists commits across pages", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "commits", "2613"]);

    expect(rendered).toContain("count: 2");
    expect(rendered).toContain("aaaaaaaaaa");
    expect(rendered).toContain("bbbbbbbbbb");
  });
});

describe("threads fixture integrity", () => {
  it("uses the real DevOpsCodeScan finding text", () => {
    expect(threads.value[0].comments[0].content).toContain(
      "Prefer String#codePointAt() over String#charCodeAt().",
    );
    expect(threads.value[0].comments[0].author.displayName).toBe("DevOpsCodeScan");
    expect(threads.value[0].threadContext?.rightFileStart.line).toBe(421);
  });
});
