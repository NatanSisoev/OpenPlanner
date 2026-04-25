# Planstack and JetBrains Junie

Planstack is a VS Code / Cursor extension. **Junie** runs inside IntelliJ-based IDEs. This document describes the supported cross-IDE workflow and artifacts.

## Tier A — Same repository

- Plans live under **`.planstack/plans/*.json`**. Any editor or agent (including Junie) that opens the same workspace folder sees the same phases and task states.
- **Dual-IDE workflow:** use Planstack in VS Code or Cursor for the sidebar and orchestration; open the **same folder** in IntelliJ and use Junie for execution or exploration. Keep Git state in mind when both IDEs touch the same files.

## Tier B — Handoff file

- When **Run phase** runs (any execution path) with `planstack.executor.writeHandoffFileOnCliRun` enabled (default), Planstack writes the generated phase prompt to **`planstack.executor.handoffFileRelativePath`** (default **`.planstack/handoff.md`**).
- **Native-first** (clipboard) mode also writes that file when `planstack.executor.writeHandoffFile` is on (default), in addition to copying the prompt.
- In Junie, **@-attach** the handoff file so the model receives the full phase instructions without pasting from the clipboard.

Optional metadata (plan id, phase id) is appended as a short footer; you may delete it before sending.

## Headless Junie CLI from VS Code

Set **`planstack.executor.activeProfile`** to **`junie-cli`** (or use the **Executor** dropdown in Planstack Chat). Store your token with **Planstack: Set Junie API token** (or `JUNIE_API_KEY` in the environment). Install the [Junie CLI](https://junie.jetbrains.com/docs/junie-cli.html); configure **`planstack.executor.juniePath`** if `junie` is not on the Extension Host `PATH`.

Junie CLI is **EAP**; flags and behavior may change. Create plan uses `--output-format json`; Run phase uses the default text stream.

## Tier C — IntelliJ-native Planstack UI (optional)

A full Planstack sidebar inside IntelliJ would require a **separate JetBrains plugin** (or official Junie integration). That is not part of this repository; track it as a product decision if you need orchestration UI without VS Code.
