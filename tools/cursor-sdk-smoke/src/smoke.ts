import { Agent } from "@cursor/february/agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The SDK may surface init failures as unhandled rejections; normalize exit for smoke tests. */
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("error: Agent.prompt failed:", msg);
  process.exit(1);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
/** HackUPC repository root (`src/` → `cursor-sdk-smoke/` → `tools/` → root). */
const repoRoot = join(__dirname, "..", "..", "..");

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("error: CURSOR_API_KEY is not set (never commit keys).");
  process.exit(3);
}

const prompt =
  "In one sentence, what is this repository about? Base your answer only on README or docs in the workspace.";

try {
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: "composer-2" },
    local: { cwd: repoRoot },
  });

  if (result.status !== "finished") {
    console.error("error: run did not finish successfully:", result.status);
    process.exit(1);
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("error: Agent.prompt failed:", msg);
  process.exit(1);
}

process.exit(0);
