/**
 * Argv for JetBrains Junie CLI (headless). See https://junie.jetbrains.com/docs/parameters.html
 * EAP — flags may change between releases.
 */
export function buildJunieCliArgs(opts: {
  cwd: string;
  authToken: string;
  timeoutMs: number;
  task: string;
  /** When set, adds `--output-format json` (Create plan). */
  outputFormatJson?: boolean;
}): string[] {
  const timeout = Math.max(10_000, opts.timeoutMs);
  const args: string[] = [
    "--skip-update-check",
    `--auth=${opts.authToken}`,
    "--project",
    opts.cwd,
    "--timeout",
    String(timeout),
  ];
  if (opts.outputFormatJson) {
    args.push("--output-format", "json");
  }
  args.push("--task", opts.task);
  return args;
}
