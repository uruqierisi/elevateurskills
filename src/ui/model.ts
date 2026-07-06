import type { StampedEvent } from "../core/events.js";

/**
 * The TUI's view model and a pure reducer over pipeline events. Keeping this
 * separate from the Ink component means the "what to show" logic is testable
 * without a terminal: feed events, assert on the model. The component is then a
 * thin, dumb projection of this state.
 */

export type StageStatus = "pending" | "running" | "done" | "failed";

export interface StageView {
  name: string;
  status: StageStatus;
  durationMs?: number;
  tokens?: number;
}

export interface CheckpointView {
  stage: string;
  artifactPaths: string[];
}

export interface TuiModel {
  runId: string;
  request: string;
  stack: string;
  model: string;
  startTs: number;
  stages: StageView[];
  activeStage?: string;
  lastTool?: string;
  /** Recent activity lines for the Active panel (raw; truncated at render). */
  tail: string[];
  totalTokens: number;
  finished: boolean;
  aborted: boolean;
  errorStage?: string;
  errorText?: string;
  checkpoint: CheckpointView | null;
  workspacePath?: string;
}

const TAIL_MAX = 8;
const LINE_CAP = 240;

export function initModel(stageNames: string[], startTs: number): TuiModel {
  return {
    runId: "",
    request: "",
    stack: "",
    model: "",
    startTs,
    stages: stageNames.map((name) => ({ name, status: "pending" })),
    tail: [],
    totalTokens: 0,
    finished: false,
    aborted: false,
    checkpoint: null,
  };
}

function setStage(stages: StageView[], name: string, patch: Partial<StageView>): StageView[] {
  return stages.map((s) => (s.name === name ? { ...s, ...patch } : s));
}

function pushTail(tail: string[], line: string): string[] {
  const next = [...tail, line.slice(0, LINE_CAP)];
  return next.length > TAIL_MAX ? next.slice(next.length - TAIL_MAX) : next;
}

/** Pure reducer: returns a new model for the event (never mutates the input). */
export function applyEvent(m: TuiModel, e: StampedEvent): TuiModel {
  switch (e.type) {
    case "run:start":
      return { ...m, runId: e.runId, request: e.request, stack: e.stack, model: e.model };

    case "stage:start":
      return {
        ...m,
        stages: setStage(m.stages, e.stage, { status: "running" }),
        activeStage: e.stage,
        lastTool: undefined,
        tail: [],
        // A (re)start clears a prior recoverable error for this stage.
        errorStage: m.errorStage === e.stage ? undefined : m.errorStage,
        errorText: m.errorStage === e.stage ? undefined : m.errorText,
      };

    case "stage:progress":
      return {
        ...m,
        lastTool: `${e.tool} ${e.summary}`,
        tail: pushTail(m.tail, `${e.tool}: ${e.summary}`),
      };

    case "agent:token":
      return { ...m, tail: pushTail(m.tail, `» ${e.text}`) };

    case "stage:gate":
      // Gate failure is not necessarily terminal (orchestrator retries); mark
      // failed only transiently. run:error drives the hard-failed state.
      return e.passed ? m : { ...m, tail: pushTail(m.tail, `gate failed: ${e.detail.split("\n")[0]}`) };

    case "stage:done":
      return {
        ...m,
        stages: setStage(m.stages, e.stage, { status: "done", durationMs: e.durationMs, tokens: e.tokens }),
        totalTokens: m.totalTokens + (e.tokens ?? 0),
        activeStage: m.activeStage === e.stage ? undefined : m.activeStage,
      };

    case "checkpoint:await":
      return { ...m, checkpoint: { stage: e.stage, artifactPaths: e.artifactPaths } };

    case "run:error":
      return {
        ...m,
        stages: setStage(m.stages, e.stage, { status: "failed" }),
        activeStage: undefined,
        errorStage: e.stage,
        errorText: e.error,
        tail: pushTail(m.tail, `ERROR: ${e.error.split("\n")[0]}`),
      };

    case "run:done":
      return { ...m, finished: true, workspacePath: e.workspacePath };

    default:
      return m;
  }
}

/** Clears a resolved checkpoint prompt. */
export function clearCheckpoint(m: TuiModel): TuiModel {
  return { ...m, checkpoint: null };
}
