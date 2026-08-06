# ado-axi

Azure DevOps CLI for agents - designed to the [AXI](https://axi.md) (Agent eXperience Interface) spec.

Wraps the official `az devops` extension (`az boards`, `az repos`, `az pipelines`, `az artifacts`) with token-efficient TOON output, contextual next-step suggestions, and structured error handling.
Built for AI coding agents that operate Azure DevOps via shell execution, instead of raw `az` calls or a generic MCP server.

`ado-axi` is meant to be the only interface a caller needs.
Anything the `az repos` command group cannot express - review threads, comment replies, build checks, policy evaluations, partial pull-request updates - goes through the Azure DevOps REST API internally, so there is never a reason to fall back to raw `az`, `curl`, or browser automation.

Not yet published to npm - see `AGENTS.md` for what's built, what's left, and how to test it against a real org.

## Requirements

- Node.js 20+
- [`az`](https://aka.ms/azure-cli) with the `azure-devops` extension: `az extension add --name azure-devops`
- Authentication for the target organization, one of:
  - `az login` - AAD/MSA identity
  - `az devops login` - personal access token
- Organization and project, resolved in this order: `--org`/`--project` flags, then `AZURE_DEVOPS_ORG_URL`/`AZURE_DEVOPS_PROJECT` (or `ADO_AXI_ORG`/`ADO_AXI_PROJECT`), then the Azure Repos git remote of the current directory, then whatever `az devops configure -d` has set.

Credentials are never handled by `ado-axi` itself.
Every call, REST calls included, runs through the Azure CLI's own credential chain, so no access token or PAT passes through this process or appears in its output.

## Usage

```sh
npm install
npm run build
node dist/bin/ado-axi.js                       # dashboard: your work items, open PRs, recent runs
node dist/bin/ado-axi.js work-item list
node dist/bin/ado-axi.js work-item view 1234
node dist/bin/ado-axi.js pipeline run 12 --branch main
node dist/bin/ado-axi.js setup hooks            # install SessionStart ambient-context hooks
```

Every command and subcommand supports `--help`.

## Pull request workflows

### Inspect a pull request in one call

```sh
ado-axi pr inspect 2613 --full
```

Returns, from a single invocation: title, description, status, draft state, author, source and target branch, repository and project, reviewers and their votes, linked work items, commits, changed files, build/check statuses, policy evaluations, and every review thread with its comments, replies, resolution state, and inline file path and line range.

The independent resources are fetched concurrently.
If one of them is unavailable - branch policies are the common case, since they need project-level read access - it is reported under `warnings` and the rest of the inspection still comes back.

`pr view` is unchanged and still returns just the metadata header.

### Read review comments, including SonarQube findings

```sh
ado-axi pr threads 2613 --unresolved            # only threads still needing attention
ado-axi pr threads 2613 --code-scan             # only SonarQube / DevOpsCodeScan findings
ado-axi pr threads 2613 --author DevOpsCodeScan
ado-axi pr thread list 2613                     # same command, alternate spelling
```

Each thread reports its id, status, whether it is resolved, the file path and line range for inline comments, and every comment's author, timestamp, and text - replies included.
Azure-generated system threads (vote changes, status updates) are hidden by default; pass `--include-system` to keep them.

A SonarQube finding comes back looking like this:

```
threads[1]:
  - thread: 98765
    status: active
    resolved: no
    file: /app/lib/files/upload-validation.ts
    lines: "421"
    author: DevOpsCodeScan
    code_scan: yes
    comments[1]{id,author,published,updated,type,text}:
      1,DevOpsCodeScan,...,text,"Prefer String#codePointAt() over String#charCodeAt().\nRule: typescript:S7758"
```

### Update a description

```sh
ado-axi pr update 2613 --description-file ./description.md --dry-run   # preview
ado-axi pr update 2613 --description-file ./description.md             # apply
```

`pr update` PATCHes only the fields you name.
Azure treats an absent field as "leave unchanged", so updating the description can never clear the title, reviewers, or anything else.

- `--dry-run` prints the fields that would change, with their current and proposed values, and sends nothing to Azure DevOps.
- A real update re-fetches the pull request afterwards and reports `verified: yes` only when the new value actually came back.
- Supported fields: `--title`, `--description`/`--description-file`, `--draft`/`--no-draft`, `--target-branch`, `--status active|abandoned`.
- Azure does not permit changing a pull request's source branch; passing `--source-branch` fails with that explanation instead of silently dropping it.

### Comment, reply, and resolve

```sh
ado-axi pr comment 2613 --description "Fixed in the latest push"
ado-axi pr comment 2613 --description "Use codePointAt here" \
  --file /app/lib/files/upload-validation.ts --line 421
ado-axi pr thread reply 2613 --thread-id 98765 --description "Done"
ado-axi pr thread resolve 2613 --thread-id 98765
ado-axi pr thread resolve 2613 --thread-id 98765 --status wontFix
```

Resolving a thread that is already in the target status is a no-op that reports `already: true` and exits 0.

### Checks, commits, and files

```sh
ado-axi pr checks 2613          # build statuses + policy evaluations, with a pass/fail summary
ado-axi pr commits 2613
ado-axi pr files 2613
```

## Output behavior

**TOON by default.** Every command renders compact TOON, not raw JSON.

**`--json`.** `pr inspect`, `pr threads`, and `pr checks` accept `--json` to emit the raw Azure DevOps payloads instead.
JSON mode preserves the exact characters Azure returned, which is what you want when a comment or description has to round-trip unchanged.

**`--full`.** Descriptions and comment bodies are truncated at ~1000 characters by default, with a `truncated, N chars total` hint.
`--full` returns the complete text, with no truncation anywhere in the output.

**Pagination.** Collections that Azure paginates - commits and changed files - are walked to completion, following continuation tokens where Azure returns them and `$top`/`$skip` where it does not.
`pr inspect` caps them at 100 commits and 200 files by default (`--commit-limit`, `--file-limit`); `pr commits` and `pr files` take `--limit`.
When a cap truncates a collection the output says so, rather than silently showing a prefix.

**UTF-8 everywhere.** Azure responses are captured as bytes and decoded as UTF-8, and every `az` child process runs with UTF-8 forced.
Em dashes, `∞`, non-ASCII names, Markdown code spans, and line breaks survive intact in both TOON and JSON output; `ado-axi` never emits a `�`.

## Errors

Failures render as structured TOON carrying the operation, the command or REST endpoint, the HTTP status or `az` exit code, the message Azure returned, remediation, and the `ado-axi` command worth running next:

```
error: "pr inspect via az repos pr show failed: TF401019: The Git repository ... does not exist."
code: NOT_FOUND
operation: pr inspect
category: az repos pr show
exitCode: 1
azureMessage: "TF401019: The Git repository ... does not exist."
help[2]:
  Run `ado-axi repo list` to see repositories
  Run `ado-axi repo list`
```

Authentication and authorization are distinguished.
A 401, or "you need to run the login command", suggests `az login` / `az devops login`; a 403 or `TF400813` does not, because you are already signed in and the fix is a permissions or PAT-scope change.

Exit codes: 0 for success or a no-op, 2 for usage errors the caller can fix without retrying (`VALIDATION_ERROR`, `ORG_NOT_CONFIGURED`, `PROJECT_NOT_CONFIGURED`), 1 for everything else.

## Development

```sh
npm run dev -- work-item list   # run from source via tsx, no build step
npm run typecheck
npm run lint
npm run test
```

See `AGENTS.md` for the full command surface, the AXI principles checklist, and known gaps.
