/**
 * Rich structured messages for the Planstack Chat webview:
 *  - animatedStatus: rotating "cooking" phrases shown while an agent run is starting
 *  - runSummary: per-file diff card shown after a successful run
 */

import type { FileDiff } from "../git/worktreeChangeSummary";

export type { FileDiff };

export interface RunSummaryData {
  phaseLabel: string;
  durationSec: number;
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  exitCode: number;
}

export interface RunFailureData {
  phaseLabel: string;
  durationSec: number;
  summary: string;
  details?: string;
  retryPrompt?: string;
}

type RichChatMessage =
  | { type: "animatedStatus"; runId: string; phrases: string[] }
  | { type: "runSummary"; runId: string; summary: RunSummaryData }
  | { type: "runFailure"; runId: string; failure: RunFailureData };

type RichChatSink = (msg: RichChatMessage) => void;

let _sink: RichChatSink | undefined;
const _buffer: RichChatMessage[] = [];
const MAX_BUFFER = 50;

export function registerRichChatSink(sink: RichChatSink | undefined): void {
  _sink = sink;
  if (sink) {
    for (const msg of _buffer.splice(0)) {
      sink(msg);
    }
  }
}

function post(msg: RichChatMessage): void {
  if (_sink) {
    _sink(msg);
    return;
  }
  if (_buffer.length < MAX_BUFFER) {
    _buffer.push(msg);
  }
}

const COOKING_PHRASES = [
  "Spooling up the braincells…",
  "Consulting the ancient scrolls…",
  "Convincing the AI to care…",
  "Compiling dreams into code…",
  "Herding the tokens…",
  "Deciphering your intentions…",
  "Summoning the code spirits…",
  "Calculating the optimal vibe…",
  "Negotiating with the model…",
  "Aligning the stars for you…",
  "Whispering to the weights…",
  "Making the computer think really hard…",
];

export function postAnimatedStatus(runId: string): void {
  post({ type: "animatedStatus", runId, phrases: COOKING_PHRASES });
}

export function postRunSummary(runId: string, summary: RunSummaryData): void {
  post({ type: "runSummary", runId, summary });
}

export function postRunFailure(runId: string, failure: RunFailureData): void {
  post({ type: "runFailure", runId, failure });
}
