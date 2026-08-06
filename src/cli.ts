import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { resolveContext, type AdoContext } from "./context.js";
import { AdoError, AxiError, exitCodeForError } from "./errors.js";
import { renderError } from "./toon.js";
import { homeCommand } from "./commands/home.js";
import { workItemCommand, WORK_ITEM_HELP } from "./commands/work-item.js";
import { prCommand, PR_HELP } from "./commands/pr.js";
import { pipelineCommand, PIPELINE_HELP } from "./commands/pipeline.js";
import { repoCommand, REPO_HELP } from "./commands/repo.js";
import { artifactCommand, ARTIFACT_HELP } from "./commands/artifact.js";
import { iterationCommand, ITERATION_HELP } from "./commands/iteration.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the az devops CLI. Prefer this over raw `az boards`/`az repos`/`az pipelines`/`az artifacts` calls for Azure DevOps operations.";
const VERSION = readPackageVersion();

type CliStdout = Pick<NodeJS.WriteStream, "write">;

type MainOptions = {
  argv?: string[];
  stdout?: CliStdout;
};

export const TOP_HELP = `usage: ado-axi [command] [args] [flags]
commands[8]:
  (none)=dashboard, work-item, pr, pipeline, repo, artifact, iteration, setup
flags[2]:
  --org <URL> (after command), --project <name> (after command), both flags accept space or equals form, --help, -v/-V/--version
examples:
  ado-axi
  ado-axi work-item list --state Active
  ado-axi work-item view 1234 --org https://dev.azure.com/contoso/
  ado-axi pr list --project MyProject
  ado-axi pr inspect 2613 --full
  ado-axi pr threads 2613 --unresolved
  ado-axi pipeline run 12 --branch main
  ado-axi setup hooks
`;

const COMMAND_HELP: Record<string, string> = {
  "work-item": WORK_ITEM_HELP,
  pr: PR_HELP,
  pipeline: PIPELINE_HELP,
  repo: REPO_HELP,
  artifact: ARTIFACT_HELP,
  iteration: ITERATION_HELP,
  setup: SETUP_HELP,
};

type CommandFn = (args: string[], ctx?: AdoContext) => Promise<string>;

const COMMANDS: Record<string, CommandFn> = {
  "work-item": withContextArgs("work-item", workItemCommand),
  pr: withContextArgs("pr", prCommand),
  pipeline: withContextArgs("pipeline", pipelineCommand),
  repo: withContextArgs("repo", repoCommand),
  artifact: withContextArgs("artifact", artifactCommand),
  iteration: withContextArgs("iteration", iterationCommand),
  setup: (args) => setupCommand(args),
};

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli<AdoContext | undefined>({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: withContextArgs(undefined, homeCommand),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
    resolveContext: ({ args }) => {
      const { orgFlag, projectFlag } = parseContextArgs(args);
      return resolveContext(orgFlag, projectFlag);
    },
    formatError: (error) => {
      if (error instanceof AxiError) {
        const details = error instanceof AdoError ? error.details : {};
        return {
          output: `${renderError(error.message, error.code, error.suggestions, { ...details })}\n`,
          exitCode: exitCodeForError(error),
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { output: `${renderError(message, "UNKNOWN")}\n`, exitCode: 1 };
    },
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    if (!existsSync(candidate)) continue;

    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }

  throw new Error("Could not determine ado-axi package version");
}

function withContextArgs(
  _command: string | undefined,
  handler: CommandFn,
): (args: string[], ctx?: AdoContext) => Promise<string> {
  return (args, ctx) => {
    const { strippedArgs } = parseContextArgs(args);
    return handler(strippedArgs, ctx);
  };
}

function parseContextArgs(args: string[]): {
  orgFlag: string | undefined;
  projectFlag: string | undefined;
  strippedArgs: string[];
} {
  const stripped: string[] = [];
  let orgFlag: string | undefined;
  let projectFlag: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--org" && index + 1 < args.length) {
      orgFlag = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("--org=") && arg.length > "--org=".length) {
      orgFlag = arg.slice("--org=".length);
      continue;
    }
    if (arg === "--project" && index + 1 < args.length) {
      projectFlag = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("--project=") && arg.length > "--project=".length) {
      projectFlag = arg.slice("--project=".length);
      continue;
    }

    stripped.push(arg);
  }

  return { orgFlag, projectFlag, strippedArgs: stripped };
}
