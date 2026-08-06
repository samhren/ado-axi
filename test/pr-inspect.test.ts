import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { clearRepositoryCache } from "../src/api/repository.js";
import { createAzMock, createStdout, flagValue, type AzMock } from "./helpers/az-mock.js";
import {
  EM_DASH,
  INFINITY,
  PR_DESCRIPTION,
  SONAR_COMMENT,
  inspectRoutes,
  pullRequest,
} from "./helpers/fixtures.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("no git repo");
  }),
}));

const mockedExecFile = vi.mocked(execFile);

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

describe("pr inspect", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    clearRepositoryCache();
    process.exitCode = undefined;
  });

  it("returns metadata, reviewers, work items, checks, policies, commits, files, and threads in one call", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "inspect", "2613"]);

    expect(rendered).toContain("id: 2613");
    expect(rendered).toContain("source: feature/upload-validation");
    expect(rendered).toContain("target: main");
    expect(rendered).toContain("repository: AI.IOS.Web");
    expect(rendered).toContain("project: AI");
    expect(rendered).toContain("Ada Lovelace");
    expect(rendered).toContain("approved");
    expect(rendered).toContain("16048");
    expect(rendered).toContain("continuous-integration/ios-web-ci");
    expect(rendered).toContain("Minimum number of reviewers");
    expect(rendered).toContain("/app/lib/files/upload-validation.ts");
    expect(rendered).toContain("aaaaaaaaaa");
    expect(rendered).toContain(SONAR_COMMENT.split("\n")[0]);
    expect(process.exitCode).toBeUndefined();
  });

  it("fetches the independent sub-resources concurrently after resolving the PR", async () => {
    const mock = install(inspectRoutes());
    await run(["pr", "inspect", "2613"]);

    // One PR read, then each sub-resource exactly once (commits paginate to two).
    expect(mock.countFor("repos pr show")).toBe(1);
    expect(mock.countFor("rest GET git/pullRequestThreads")).toBe(1);
    expect(mock.countFor("rest GET git/pullRequestStatuses")).toBe(1);
    expect(mock.countFor("rest GET policy/evaluations")).toBe(1);
    expect(mock.countFor("rest GET git/pullRequestCommits")).toBe(2);
  });

  it("preserves an em dash in the description and never emits a replacement character", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "inspect", "2613", "--full"]);

    expect(rendered).toContain(EM_DASH);
    expect(rendered).toContain("日本語");
    expect(rendered).not.toContain("�");
  });

  it("preserves an infinity symbol inside a review comment", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "inspect", "2613", "--full"]);

    expect(rendered).toContain(INFINITY);
    expect(rendered).not.toContain("�");
  });

  it("--full keeps the complete description while the default truncates it", async () => {
    install(inspectRoutes());
    const full = await run(["pr", "inspect", "2613", "--full", "--json"]);
    const parsed = JSON.parse(full) as { pull_request: { description: string } };
    expect(parsed.pull_request.description).toBe(PR_DESCRIPTION);

    mockedExecFile.mockReset();
    clearRepositoryCache();
    install(inspectRoutes({ "repos pr show": { json: longDescriptionPr() } }));
    const truncated = await run(["pr", "inspect", "2613"]);
    expect(truncated).toContain("use --full to see the complete text");
  });

  it("--json preserves exact Unicode and the raw Azure shapes", async () => {
    install(inspectRoutes());
    const rendered = await run(["pr", "inspect", "2613", "--json"]);
    const parsed = JSON.parse(rendered) as {
      pull_request: { title: string };
      threads: Array<{ comments: Array<{ content: string }> }>;
      commits: unknown[];
    };

    expect(parsed.pull_request.title).toBe(pullRequest.title);
    expect(parsed.threads[0].comments[0].content).toBe(SONAR_COMMENT);
    expect(parsed.threads[1].comments[0].content).toContain(INFINITY);
    // Both commit pages are present, so pagination survives JSON mode.
    expect(parsed.commits).toHaveLength(2);
  });

  it("walks continuation tokens until the collection is exhausted", async () => {
    const mock = install(inspectRoutes());
    const rendered = await run(["pr", "inspect", "2613"]);

    const commitCalls = mock.callsFor("rest GET git/pullRequestCommits");
    expect(commitCalls).toHaveLength(2);
    expect(commitCalls[0].args.join(" ")).not.toContain("continuationToken");
    expect(commitCalls[1].args.join(" ")).toContain("continuationToken=page2");
    expect(rendered).toContain("aaaaaaaaaa");
    expect(rendered).toContain("bbbbbbbbbb");
  });

  it("resolves the repository GUID from the PR itself, without an extra lookup", async () => {
    const mock = install(inspectRoutes());
    await run(["pr", "inspect", "2613"]);

    expect(mock.countFor("repos show")).toBe(0);
    const threadCall = mock.callsFor("rest GET git/pullRequestThreads")[0];
    expect(threadCall.args.join(" ")).toContain(`repositoryId=${pullRequest.repository.id}`);
    expect(threadCall.args.join(" ")).toContain("project=AI");
  });

  it("looks the repository GUID up by name, and caches it, when the PR omits it", async () => {
    const prWithoutGuid = {
      ...pullRequest,
      repository: { name: "AI.IOS.Web", project: { id: pullRequest.repository.project.id, name: "AI" } },
    };
    const mock = install({
      ...inspectRoutes({ "repos pr show": { json: prWithoutGuid } }),
      "repos show": { json: { id: pullRequest.repository.id, name: "AI.IOS.Web" } },
    });

    await run(["pr", "inspect", "2613"]);
    await run(["pr", "inspect", "2613"]);

    // Two inspections, but the name -> GUID lookup only happened once.
    expect(mock.countFor("repos pr show")).toBe(2);
    expect(mock.countFor("repos show")).toBe(1);
    expect(mock.callsFor("rest GET git/pullRequestThreads")[1].args.join(" ")).toContain(
      `repositoryId=${pullRequest.repository.id}`,
    );
  });

  it("never passes --project to an az command that does not accept it", async () => {
    const mock = install(inspectRoutes());
    await run(["pr", "inspect", "2613", "--project", "AI", "--org", "contoso"]);

    for (const call of mock.calls) {
      const path = call.args.slice(0, 3).join(" ");
      if (path.startsWith("repos pr show") || path.startsWith("devops invoke")) {
        expect(call.args).not.toContain("--project");
      }
      expect(call.args).toContain("--organization");
    }
  });

  it("degrades to a warning when one sub-resource is forbidden, instead of failing the whole inspection", async () => {
    install(
      inspectRoutes({
        "rest GET policy/evaluations": {
          stderr: "ERROR: TF400813: The user is not authorized to access this resource.",
          exitCode: 1,
        },
      }),
    );
    const rendered = await run(["pr", "inspect", "2613"]);

    expect(process.exitCode).toBeUndefined();
    expect(rendered).toContain("warnings");
    expect(rendered).toContain("could not read policy evaluations");
    // The rest of the inspection still came through.
    expect(rendered).toContain("continuous-integration/ios-web-ci");
  });

  it("propagates a useful Azure error, with operation and endpoint, when the PR itself cannot be read", async () => {
    install({
      "repos pr show": {
        stderr: "ERROR: TF401019: The Git repository with name or identifier AI.IOS.Web does not exist.",
        exitCode: 1,
      },
    });
    const rendered = await run(["pr", "inspect", "2613"]);

    expect(process.exitCode).toBe(1);
    expect(rendered).toContain("pr inspect");
    expect(rendered).toContain("az repos pr show");
    expect(rendered).toContain("TF401019");
    expect(rendered).toContain("NOT_FOUND");
    expect(rendered).not.toContain("unexpected error");
  });

  it("reports HTTP status and endpoint for a failing REST call", async () => {
    install(
      inspectRoutes({
        "rest GET git/pullRequestThreads": {
          stderr: "ERROR: (404) Not Found. The pull request does not exist.",
          exitCode: 1,
        },
      }),
    );
    const rendered = await run(["pr", "threads", "2613"]);

    expect(process.exitCode).toBe(1);
    expect(rendered).toContain("pr threads");
    expect(rendered).toContain("git/pullRequestThreads");
    expect(rendered).toContain("status: 404");
  });

  it("suggests az login for an auth failure but not for a permissions failure", async () => {
    install({
      "repos pr show": {
        stderr:
          "ERROR: Before you can run Azure DevOps commands, you need to run the login command(az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.",
        exitCode: 1,
      },
    });
    const authOutput = await run(["pr", "inspect", "2613"]);
    expect(authOutput).toContain("AUTH_REQUIRED");
    expect(authOutput).toContain("az login");

    mockedExecFile.mockReset();
    install({
      "repos pr show": {
        stderr: "ERROR: TF400813: The user is not authorized to access this resource.",
        exitCode: 1,
      },
    });
    const forbiddenOutput = await run(["pr", "inspect", "2613"]);
    expect(forbiddenOutput).toContain("FORBIDDEN");
    expect(forbiddenOutput).not.toContain("`az login`");
  });

  it("captures the REST response from --out-file rather than the terminal", async () => {
    const mock = install(inspectRoutes());
    await run(["pr", "inspect", "2613"]);

    for (const call of mock.callsFor("rest GET git/pullRequestThreads")) {
      expect(flagValue(call.args, "--out-file")).toBeDefined();
    }
  });
});

function longDescriptionPr() {
  return { ...pullRequest, description: `${EM_DASH} ${"x".repeat(1200)}` };
}
