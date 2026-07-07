/**
 * The event contract between pipeline logic and any UI.
 *
 * The orchestrator and agents emit these structured events on an EventBus. UI
 * renderers only subscribe and render — they never touch orchestrator or agent
 * logic. This is the seam that lets the TUI be swapped, forced off (--plain),
 * or removed entirely without changing the pipeline, and keeps piped/CI output
 * working through the plain renderer.
 */

/** One item in an agent's plan/todo checklist (sourced from plan.json). */
export interface TodoItem {
  text: string;
  done: boolean;
}

export type PipelineEvent =
  | { type: "run:start"; runId: string; request: string; stack: string; model: string }
  | { type: "stage:start"; stage: string; agent: string }
  | { type: "stage:progress"; stage: string; tool: string; summary: string }
  | { type: "agent:token"; stage: string; text: string }
  | { type: "agent:thinking"; stage: string; text: string }
  | { type: "agent:todo"; stage: string; items: TodoItem[] }
  | { type: "stage:gate"; stage: string; passed: boolean; detail: string }
  | { type: "stage:done"; stage: string; durationMs: number; artifacts: string[]; tokens?: number }
  | { type: "usage"; model: string; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "checkpoint:await"; stage: string; artifactPaths: string[] }
  | { type: "run:done"; runId: string; workspacePath: string; summary: string; repoUrl?: string }
  | { type: "run:error"; stage: string; error: string };

/** Event as delivered to handlers: the payload plus an emit timestamp. */
export type StampedEvent = PipelineEvent & { ts: number };

export type EventHandler = (event: StampedEvent) => void;

/**
 * Minimal synchronous pub/sub. Handlers run in subscription order. Kept tiny on
 * purpose — no wildcards, no async fan-out — so it can never become a place
 * where logic leaks into the UI layer.
 */
export class EventBus {
  private handlers: Set<EventHandler> = new Set();

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: PipelineEvent): void {
    const stamped: StampedEvent = { ...event, ts: Date.now() } as StampedEvent;
    for (const handler of this.handlers) {
      try {
        handler(stamped);
      } catch {
        // A broken renderer must never take down the pipeline.
      }
    }
  }
}

/** The decision a checkpoint UI returns for a paused stage. */
export type CheckpointDecision = "continue" | "retry" | "quit";
