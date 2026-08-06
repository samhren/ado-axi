/**
 * Which `az` commands actually accept which context flags.
 *
 * `az repos pr update`, `az repos pr show`, `az boards work-item show` and friends
 * take an id that is already globally unique inside an organization, so the
 * azure-devops extension never declared a `--project` argument for them. Appending
 * one anyway makes argparse fail with "unrecognized arguments: --project", which is
 * exactly the failure this table exists to prevent.
 *
 * Verified against azure-devops extension 1.0.x (`az <command> --help`). Commands
 * that are not listed are treated as NOT supporting the flag, so a newly wired
 * command fails loudly in review rather than silently breaking at runtime.
 */

/** az command paths (leading non-flag words) that accept `--project`. */
const PROJECT_FLAG_COMMANDS: ReadonlySet<string> = new Set([
  "repos list",
  "repos show",
  "repos create",
  "repos delete",
  "repos pr create",
  "repos pr list",
  "boards query",
  "boards work-item create",
  "boards work-item delete",
  "boards iteration project list",
  "boards iteration project create",
  "boards iteration team list",
  "boards iteration team show-default-iteration",
  "pipelines list",
  "pipelines show",
  "pipelines run",
  "pipelines runs list",
  "pipelines runs show",
  "pipelines build cancel",
  "artifacts universal download",
  "artifacts universal publish",
]);

/** az command paths that accept `--organization`. In practice this is every devops command. */
const NO_ORG_FLAG_COMMANDS: ReadonlySet<string> = new Set(["extension add", "login", "logout"]);

/** The leading non-flag words of an az argv - e.g. ["repos","pr","show","--id"] -> "repos pr show". */
export function azCommandPath(args: string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  return words.join(" ");
}

/** True when the az command identified by `args` declares a `--project` argument. */
export function supportsProjectFlag(args: string[]): boolean {
  return PROJECT_FLAG_COMMANDS.has(azCommandPath(args));
}

/** True when the az command identified by `args` declares an `--organization` argument. */
export function supportsOrgFlag(args: string[]): boolean {
  return !NO_ORG_FLAG_COMMANDS.has(azCommandPath(args));
}
