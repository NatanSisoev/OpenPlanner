/**
 * Webview copy for run actions. Keep keys/values in sync with
 * extension/src/ui/runUiStrings.ts (PS_RUN_UI).
 */
(function () {
  globalThis.__PS_RUN_UI = {
    glyph: "\u25b6",

    runPlanButton: "Run plan",
    runPhaseButton: "Run phase",
    runTaskButton: "Run task",

    runPlanTooltip: "Runs phases in order from the next runnable phase.",
    runPhaseTooltip: "Runs this phase with the configured executor (CLI, etc.).",
    runTaskTooltip: "Runs this task with the configured executor.",

    chatStreamRunPhase: "Run phase",
    chatStreamRunTask: "Run task",
    chatStreamCreatePlan: "Create plan",
    chatStreamSendPrompt: "Send prompt",

    cliPhaseDefaultStreamLabel: "Run phase",

    streamStartedSuffix: "started",
  };
})();
