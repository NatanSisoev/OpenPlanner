/**
 * User-visible run vocabulary for Planstack (extension host + webviews).
 * Keep in sync with `extension/media/planstackRunLabels.js`.
 */
export const PS_RUN_UI = {
  glyph: "\u25b6",

  runPlanButton: "Run plan",
  runPhaseButton: "Run phase",
  runTaskButton: "Run task",

  runPlanTooltip: "Runs phases in order from the next runnable phase.",
  runPhaseTooltip: "Runs this phase with the configured executor (CLI, etc.).",
  runTaskTooltip: "Runs this task with the configured executor.",
  /** Sidebar when `task.prompt` is empty and `planstack.requireTaskPrompt` is true */
  runTaskNeedsPromptTooltip:
    "Add a task prompt first (open task details, Edit prompt ✎, save) or set it in the plan JSON. Or disable planstack.requireTaskPrompt to run using the task title only.",

  chatStreamRunPhase: "Run phase",
  chatStreamRunTask: "Run task",
  chatStreamCreatePlan: "Create plan",
  chatStreamSendPrompt: "Send prompt",

  /** When no statusLabel is passed into CLI handoff stream metadata */
  cliPhaseDefaultStreamLabel: "Run phase",

  vscodeProgressRunPhase: "Planstack: Run phase (Cursor CLI)…",
  vscodeProgressRunPhaseJunie: "Planstack: Run phase (Junie CLI)…",

  /** Chat separator: "<action> started" */
  streamStartedSuffix: "started",

  runPhaseRequestPrefix: "Run phase request:",
  runTaskRequestPrefix: "Run task request:",

  /** Output / chat lines for task runs */
  runTaskLogStarted: "Run task started",
  runTaskChatStarting: "Run task — starting",
  runTaskChatCompleted: "Run task completed",
  runTaskChatStopped: "Run task stopped",
  runTaskChatFailed: "Run task failed",

  runTaskThrottleStdoutPrefix: "Run task: ",
  runTaskThrottleStderrPrefix: "Run task (stderr): ",

  runTaskFailureSummaryStopped: "Run task stopped by user",
  runTaskFailureSummaryFailed: "Run task failed",
} as const;
