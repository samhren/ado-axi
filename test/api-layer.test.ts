import { describe, expect, it } from "vitest";
import {
  azCommandPath,
  supportsOrgFlag,
  supportsProjectFlag,
} from "../src/api/az-capabilities.js";
import { withOrgProject, type AdoContext } from "../src/context.js";
import { decodeUtf8, describeAzCommand } from "../src/az.js";
import { exitCodeForError, mapAzError, parseHttpStatus, AdoError } from "../src/errors.js";
import { assertUsableApiVersion } from "../src/api/rest.js";
import {
  checkSummary,
  filterThreads,
  isSystemThread,
  threadLines,
  toCheckViews,
  toCodeScanFindings,
  toPolicyViews,
  toThreadView,
} from "../src/commands/pr-format.js";
import { isThreadUnresolved, normalizeThreadStatus } from "../src/api/types.js";
import { SONAR_COMMENT, threads } from "./helpers/fixtures.js";

const ctx: AdoContext = {
  org: { value: "https://dev.azure.com/contoso/", source: "flag" },
  project: { value: "AI", source: "flag" },
};

describe("az capability table", () => {
  it("extracts the command path from an argv", () => {
    expect(azCommandPath(["repos", "pr", "show", "--id", "1"])).toBe("repos pr show");
    expect(describeAzCommand(["devops", "invoke", "--area", "git"])).toBe("devops invoke");
  });

  it.each([
    "repos pr show",
    "repos pr update",
    "repos pr set-vote",
    "repos pr reviewer list",
    "repos pr work-item list",
    "devops invoke",
  ])("knows that `az %s` has no --project argument", (command) => {
    expect(supportsProjectFlag(command.split(" "))).toBe(false);
  });

  it.each(["repos pr list", "repos pr create", "repos list", "boards query", "pipelines list"])(
    "knows that `az %s` accepts --project",
    (command) => {
      expect(supportsProjectFlag(command.split(" "))).toBe(true);
    },
  );

  it("treats an unknown command as not supporting --project, so nothing is appended blindly", () => {
    expect(supportsProjectFlag(["some", "future", "command"])).toBe(false);
  });

  it("appends --organization to devops commands", () => {
    expect(supportsOrgFlag(["repos", "pr", "show"])).toBe(true);
    expect(supportsOrgFlag(["extension", "add"])).toBe(false);
  });
});

describe("withOrgProject", () => {
  it("omits --project for `az repos pr update` even when a project is resolved", () => {
    const args = withOrgProject(["repos", "pr", "update", "--id", "2613"], ctx);
    expect(args).not.toContain("--project");
    expect(args).toContain("--organization");
  });

  it("includes --project for `az repos pr list`", () => {
    const args = withOrgProject(["repos", "pr", "list"], ctx);
    expect(args).toContain("--project");
    expect(args[args.indexOf("--project") + 1]).toBe("AI");
  });

  it("still honours an explicit project: false override", () => {
    const args = withOrgProject(["repos", "pr", "list"], ctx, { project: false });
    expect(args).not.toContain("--project");
  });

  it("omits a default-sourced org so the child az applies its own default", () => {
    const args = withOrgProject(["repos", "pr", "list"], {
      org: { value: "https://dev.azure.com/contoso/", source: "default" },
    });
    expect(args).not.toContain("--organization");
  });
});

describe("decodeUtf8", () => {
  it("decodes a Buffer as UTF-8 regardless of the platform code page", () => {
    expect(decodeUtf8(Buffer.from("em dash — infinity ∞", "utf-8"))).toBe("em dash — infinity ∞");
  });

  it("strips a UTF-8 BOM", () => {
    expect(decodeUtf8(Buffer.from("﻿{\"a\":1}", "utf-8"))).toBe('{"a":1}');
  });

  it("passes strings through and treats absent output as empty", () => {
    expect(decodeUtf8("plain")).toBe("plain");
    expect(decodeUtf8(undefined)).toBe("");
    expect(decodeUtf8(null)).toBe("");
  });
});

describe("error details", () => {
  it("names the operation, category, exit code, and Azure message", () => {
    const error = mapAzError("ERROR: TF401019: The Git repository does not exist.", 1, {
      operation: "pr inspect",
      category: "az repos pr show",
      nextCommand: "ado-axi repo list",
    });

    expect(error).toBeInstanceOf(AdoError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("pr inspect");
    expect(error.message).toContain("az repos pr show");
    expect(error.details.exitCode).toBe(1);
    expect(error.details.azureMessage).toContain("TF401019");
    expect(error.suggestions).toContain("Run `ado-axi repo list`");
  });

  it("captures an HTTP status from a REST failure", () => {
    const error = mapAzError("ERROR: (404) Not Found.", 1, {
      operation: "pr threads",
      endpoint: "GET git/pullRequestThreads",
    });
    expect(error.details.status).toBe(404);
    expect(error.message).toContain("GET git/pullRequestThreads");
  });

  it.each([
    ["ERROR: (401) Unauthorized", "AUTH_REQUIRED"],
    ["ERROR: (403) Forbidden", "FORBIDDEN"],
    ["ERROR: (409) Conflict on update", "CONFLICT"],
    ["ERROR: (429) too many requests", "RATE_LIMITED"],
    ["ERROR: (503) Service Unavailable", "SERVER_ERROR"],
  ])("classifies %s as %s", (stderr, code) => {
    expect(mapAzError(stderr, 1).code).toBe(code);
  });

  it("suggests az login only for authentication, not for a permissions failure", () => {
    const auth = mapAzError("ERROR: (401) Unauthorized", 1);
    expect(auth.suggestions.join(" ")).toContain("az login");

    const forbidden = mapAzError("ERROR: TF400813: The user is not authorized", 1);
    expect(forbidden.suggestions.join(" ")).not.toContain("az login");
    expect(forbidden.suggestions.join(" ")).toContain("permission");
  });

  it("flags an argument az does not accept as an ado-axi bug", () => {
    const error = mapAzError("ERROR: unrecognized arguments: --project AI", 2);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("--project AI");
  });

  it("explains an api-version az devops invoke cannot parse", () => {
    const error = mapAzError("ERROR: could not convert string to float: '7.1.1'", 1, {
      operation: "pr inspect",
    });
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("api-version");
    expect(error.message).toContain("7.1.1");
    expect(error.suggestions.join(" ")).toContain("7.1-preview.1");
  });

  it("explains a Windows console encoding crash instead of leaving it raw", () => {
    const error = mapAzError(
      "UnicodeEncodeError: 'charmap' codec can't encode character '\\u221e' in position 42",
      1,
    );
    expect(error.message).toContain("non-ASCII");
    expect(error.suggestions.join(" ")).toContain("PYTHONUTF8");
  });

  it("parses statuses from the shapes az prints them in", () => {
    expect(parseHttpStatus("ERROR: (404) Not Found")).toBe(404);
    expect(parseHttpStatus("status code: 500")).toBe(500);
    expect(parseHttpStatus("no status here")).toBeUndefined();
  });
});

describe("api-version validation", () => {
  // Mirrors azext_devops/dev/team/invoke.py#apiVersionToFloat: strip `-preview`,
  // then float() the remainder.
  it.each(["7.1", "7.1-preview", "6", "5.0", "7.2-preview"])("accepts %s", (version) => {
    expect(() => assertUsableApiVersion(version)).not.toThrow();
  });

  it.each(["7.1-preview.1", "7.1-preview.3", "7.1.1", "latest", ""])(
    "rejects %s, which az would crash on",
    (version) => {
      expect(() => assertUsableApiVersion(version)).toThrow(AdoError);
    },
  );

  it("names the offending version and exits as a usage error", () => {
    try {
      assertUsableApiVersion("7.1-preview.1");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AdoError);
      expect((error as AdoError).message).toContain("7.1-preview.1");
      expect(exitCodeForError(error)).toBe(2);
    }
  });
});

describe("thread shaping", () => {
  const [sonarThread, resolvedThread, systemThread] = threads.value;

  it("renders a single inline line and a line range", () => {
    expect(threadLines(sonarThread)).toBe("421");
    expect(threadLines(resolvedThread)).toBe("88-92");
    expect(threadLines(systemThread)).toBe("");
  });

  it("recognizes Azure-generated system threads", () => {
    expect(isSystemThread(systemThread)).toBe(true);
    expect(isSystemThread(sonarThread)).toBe(false);
  });

  it("classifies thread statuses as resolved or not", () => {
    expect(isThreadUnresolved("active")).toBe(true);
    expect(isThreadUnresolved("pending")).toBe(true);
    expect(isThreadUnresolved("fixed")).toBe(false);
    expect(isThreadUnresolved("closed")).toBe(false);
  });

  it("keeps the DevOpsCodeScan comment text, author, file, and line intact", () => {
    const view = toThreadView(sonarThread, true);
    expect(view.author).toBe("DevOpsCodeScan");
    expect(view.file).toBe("/app/lib/files/upload-validation.ts");
    expect(view.lines).toBe("421");
    expect(view.resolved).toBe("no");
    expect(view.code_scan).toBe("yes");
    expect(view.comments[0].text).toBe(SONAR_COMMENT);
  });

  it("truncates comment text without --full and preserves it with --full", () => {
    const long = {
      id: 1,
      status: "active",
      comments: [{ id: 1, author: { displayName: "Ada" }, content: "y".repeat(1500) }],
    };
    expect(toThreadView(long, false).comments[0].text).toContain("use --full");
    expect(toThreadView(long, true).comments[0].text).toHaveLength(1500);
  });

  it("filters by resolution, author, and code-scan origin", () => {
    expect(filterThreads(threads.value, {})).toHaveLength(2);
    expect(filterThreads(threads.value, { includeSystem: true })).toHaveLength(3);
    expect(filterThreads(threads.value, { unresolvedOnly: true })).toHaveLength(1);
    expect(filterThreads(threads.value, { codeScanOnly: true })).toHaveLength(1);
    expect(filterThreads(threads.value, { author: "ada@contoso.com" })).toHaveLength(1);
    expect(filterThreads(threads.value, { author: "nobody" })).toHaveLength(0);
  });

  it("indexes code-scan findings without repeating their text", () => {
    const findings = toCodeScanFindings(threads.value.map((t) => toThreadView(t, true)));
    expect(findings).toEqual([
      {
        thread: 98765,
        author: "DevOpsCodeScan",
        file: "/app/lib/files/upload-validation.ts",
        lines: "421",
        resolved: "no",
      },
    ]);
  });

  it("normalizes thread status names case-insensitively", () => {
    expect(normalizeThreadStatus("WONTFIX")).toBe("wontFix");
    expect(normalizeThreadStatus("closed")).toBe("closed");
    expect(normalizeThreadStatus("nonsense")).toBeUndefined();
  });
});

describe("check summary", () => {
  it("counts states and unmet blocking policies", () => {
    const checks = toCheckViews([
      { state: "succeeded", context: { name: "ci" } },
      { state: "failed", context: { name: "sonar" } },
      { state: "pending", context: { name: "e2e" } },
    ]);
    const policies = toPolicyViews([
      { status: "approved", configuration: { isBlocking: true, type: { displayName: "Reviewers" } } },
      { status: "rejected", configuration: { isBlocking: true, type: { displayName: "Build" } } },
      { status: "rejected", configuration: { isBlocking: false, type: { displayName: "Comments" } } },
    ]);

    expect(checkSummary(checks, policies)).toBe(
      "1 succeeded, 1 failed, 1 pending, 1 blocking policy unmet",
    );
  });

  it("reads cleanly with nothing configured", () => {
    expect(checkSummary([], [])).toBe("0 succeeded, 0 blocking policies unmet");
  });
});
