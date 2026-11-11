import { create } from 'zustand';

import type { TrafficFrame } from '../../simulation/traffic-telemetry';
import { TRAFFIC_MAX_FRAMES_PER_SCOPE } from '../../simulation/traffic-telemetry';

/**
 * Browser-only telemetry store. It is deliberately separate from every
 * persisted editor store and from the result API/export. Frames live in RAM,
 * are scoped to one level/run, and are dropped on stop, reset, stale binding,
 * level switch or unmount.
 */

export type TrafficLevelId = TrafficFrame['levelId'];
export type TrafficMode =
  | 'idle'
  | 'live'
  | 'completed'
  | 'replay-paused'
  | 'replay-playing';

export interface TrafficRunIdentity {
  levelId: TrafficLevelId;
  runId: string;
  /** Identity includes level, graph digest/revision and seed. */
  binding: string;
}

export interface TrafficScopeSummary {
  scopeId: string;
  scopeLabel: string;
  frameCount: number;
}

interface ObservedScope {
  scopeId: string;
  scopeLabel: string;
  frames: TrafficFrame[];
}

interface ObservedRun extends TrafficRunIdentity {
  scopes: Map<string, ObservedScope>;
  scopeOrder: string[];
  totalFrames: number;
}

export interface TrafficState {
  run: TrafficRunIdentity | null;
  mode: TrafficMode;
  liveFrame: TrafficFrame | null;
  liveScopeId: string | null;
  /** True while the (Cold Cache) run is paused; the last frame stays visible but static. */
  livePaused: boolean;
  replayScopeId: string | null;
  replayIndex: number;
  replayFrame: TrafficFrame | null;
  scopes: readonly TrafficScopeSummary[];
  beginRun: (identity: TrafficRunIdentity) => void;
  /** Accept one measured frame only for the live run it belongs to. */
  acceptFrame: (input: {
    levelId: TrafficLevelId;
    runId: string;
    frame: TrafficFrame;
  }) => boolean;
  completeRun: (runId: string) => void;
  abortRun: (runId?: string) => void;
  /** Make the last live frame static immediately; pending coalesced updates are dropped. */
  pauseLive: (runId?: string) => void;
  /** Re-enable live motion after resume. */
  resumeLive: (runId?: string) => void;
  /** Drop everything when the current graph/seed/level no longer matches. */
  syncRunBinding: (input: {
    levelId: TrafficLevelId;
    runId: string | null;
    binding: string;
  }) => void;
  startReplay: (scopeId?: string) => void;
  setReplayScope: (scopeId: string) => void;
  playReplay: () => void;
  pauseReplay: () => void;
  seekReplay: (index: number) => void;
  /** Advance one recorded sample while replay is playing; stop at the end. */
  advanceReplay: () => void;
  exitReplay: () => void;
  reset: () => void;
}

export const TRAFFIC_MAX_FRAMES_TOTAL = 2_000;
const LIVE_FLUSH_MS = 100;

const observedRuns = new Map<string, ObservedRun>();
let pendingLive: {
  levelId: TrafficLevelId;
  runId: string;
  scopeId: string;
  frame: TrafficFrame;
} | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastLiveEmitAt = 0;

function runKey(levelId: TrafficLevelId, runId: string): string {
  return `${levelId}:${runId}`;
}

function clearLiveTimers(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingLive = null;
  lastLiveEmitAt = 0;
}

function emptyState(): Pick<
  TrafficState,
  | 'run'
  | 'mode'
  | 'liveFrame'
  | 'liveScopeId'
  | 'livePaused'
  | 'replayScopeId'
  | 'replayIndex'
  | 'replayFrame'
  | 'scopes'
> {
  return {
    run: null,
    mode: 'idle',
    liveFrame: null,
    liveScopeId: null,
    livePaused: false,
    replayScopeId: null,
    replayIndex: 0,
    replayFrame: null,
    scopes: [],
  };
}

function scopeSummaries(run: ObservedRun): TrafficScopeSummary[] {
  return run.scopeOrder
    .map((scopeId) => run.scopes.get(scopeId))
    .filter((scope): scope is ObservedScope => scope !== undefined)
    .map((scope) => ({
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
      frameCount: scope.frames.length,
    }));
}

function trimObservedRun(run: ObservedRun): void {
  for (const scope of run.scopes.values()) {
    while (scope.frames.length > TRAFFIC_MAX_FRAMES_PER_SCOPE) {
      scope.frames.shift();
      run.totalFrames -= 1;
    }
  }
  while (run.totalFrames > TRAFFIC_MAX_FRAMES_TOTAL) {
    const oldest = run.scopeOrder
      .map((scopeId) => run.scopes.get(scopeId))
      .find((scope) => scope !== undefined && scope.frames.length > 0);
    if (!oldest) {
      break;
    }
    oldest.frames.shift();
    run.totalFrames -= 1;
  }
}

function appendObservedFrame(
  run: ObservedRun,
  frame: TrafficFrame,
): ObservedScope {
  let scope = run.scopes.get(frame.scopeId);
  if (!scope) {
    scope = {
      scopeId: frame.scopeId,
      scopeLabel: frame.scopeLabel,
      frames: [],
    };
    run.scopes.set(frame.scopeId, scope);
    run.scopeOrder.push(frame.scopeId);
  } else {
    scope.scopeLabel = frame.scopeLabel;
  }
  const previous = scope.frames.at(-1);
  if (
    previous &&
    previous.timeMs === frame.timeMs &&
    previous.phase === frame.phase
  ) {
    scope.frames[scope.frames.length - 1] = frame;
    return scope;
  }
  scope.frames.push(frame);
  run.totalFrames += 1;
  trimObservedRun(run);
  return scope;
}

function observedScope(
  levelId: TrafficLevelId,
  runId: string,
  scopeId: string,
): ObservedScope | null {
  return (
    observedRuns.get(runKey(levelId, runId))?.scopes.get(scopeId) ?? null
  );
}

export function observedTrafficScopes(
  levelId: TrafficLevelId,
  runId: string | null,
): readonly TrafficScopeSummary[] {
  if (!runId) {
    return [];
  }
  const run = observedRuns.get(runKey(levelId, runId));
  return run ? scopeSummaries(run) : [];
}

export function observedTrafficFrames(
  levelId: TrafficLevelId,
  runId: string | null,
  scopeId: string | null,
): readonly TrafficFrame[] {
  if (!runId || !scopeId) {
    return [];
  }
  return observedScope(levelId, runId, scopeId)?.frames ?? [];
}

function scheduleLiveFlush(): void {
  if (flushTimer !== null) {
    return;
  }
  const delay = Math.max(0, LIVE_FLUSH_MS - (Date.now() - lastLiveEmitAt));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const pending = pendingLive;
    pendingLive = null;
    if (!pending) {
      return;
    }
    const state = useTrafficStore.getState();
    if (
      state.mode !== 'live' ||
      state.run?.levelId !== pending.levelId ||
      state.run?.runId !== pending.runId
    ) {
      return;
    }
    lastLiveEmitAt = Date.now();
    useTrafficStore.setState({
      liveFrame: pending.frame,
      liveScopeId: pending.scopeId,
    });
  }, delay);
}

function replayFrameAt(
  levelId: TrafficLevelId,
  runId: string,
  scopeId: string | null,
  index: number,
): TrafficFrame | null {
  if (!scopeId) {
    return null;
  }
  const scope = observedScope(levelId, runId, scopeId);
  if (!scope || scope.frames.length === 0) {
    return null;
  }
  const bounded = Math.min(
    scope.frames.length - 1,
    Math.max(0, Math.round(index)),
  );
  return scope.frames[bounded] ?? null;
}

export const useTrafficStore = create<TrafficState>((set, get) => ({
  ...emptyState(),

  beginRun: (identity) => {
    clearLiveTimers();
    observedRuns.clear();
    observedRuns.set(runKey(identity.levelId, identity.runId), {
      ...identity,
      scopes: new Map(),
      scopeOrder: [],
      totalFrames: 0,
    });
    set({
      ...emptyState(),
      run: { ...identity },
      mode: 'live',
    });
  },

  acceptFrame: ({ levelId, runId, frame }) => {
    const state = get();
    if (
      !state.run ||
      state.run.levelId !== levelId ||
      state.run.runId !== runId ||
      frame.levelId !== levelId ||
      state.mode !== 'live'
    ) {
      return false;
    }
    const run = observedRuns.get(runKey(levelId, runId));
    if (!run) {
      return false;
    }
    appendObservedFrame(run, frame);
    // A paused run keeps the last visible sample static. New frames may still
    // be buffered for replay, but must not restart motion or replace the value
    // the player is looking at until resume.
    if (state.livePaused) {
      return true;
    }
    const now = Date.now();
    if (state.liveFrame === null || now - lastLiveEmitAt >= LIVE_FLUSH_MS) {
      pendingLive = null;
      lastLiveEmitAt = now;
      set({ liveFrame: frame, liveScopeId: frame.scopeId });
    } else {
      pendingLive = { levelId, runId, scopeId: frame.scopeId, frame };
      scheduleLiveFlush();
    }
    return true;
  },

  completeRun: (runId) => {
    const state = get();
    if (!state.run || state.run.runId !== runId) {
      return;
    }
    clearLiveTimers();
    const run = observedRuns.get(runKey(state.run.levelId, runId));
    set({
      mode: 'completed',
      liveFrame: null,
      liveScopeId: null,
      livePaused: false,
      replayScopeId: null,
      replayIndex: 0,
      replayFrame: null,
      scopes: run ? scopeSummaries(run) : [],
    });
  },

  abortRun: (runId) => {
    const state = get();
    if (!state.run) {
      return;
    }
    if (runId !== undefined && state.run.runId !== runId) {
      return;
    }
    clearLiveTimers();
    observedRuns.delete(runKey(state.run.levelId, state.run.runId));
    set(emptyState());
  },

  pauseLive: (runId) => {
    const state = get();
    if (!state.run || state.mode !== 'live') {
      return;
    }
    if (runId !== undefined && state.run.runId !== runId) {
      return;
    }
    clearLiveTimers();
    set({ livePaused: true });
  },

  resumeLive: (runId) => {
    const state = get();
    if (!state.run || state.mode !== 'live') {
      return;
    }
    if (runId !== undefined && state.run.runId !== runId) {
      return;
    }
    lastLiveEmitAt = Date.now();
    set({ livePaused: false });
  },

  syncRunBinding: ({ levelId, runId, binding }) => {
    const state = get();
    if (!state.run) {
      return;
    }
    if (
      runId === null ||
      state.run.levelId !== levelId ||
      state.run.runId !== runId ||
      state.run.binding !== binding
    ) {
      clearLiveTimers();
      observedRuns.delete(runKey(state.run.levelId, state.run.runId));
      set(emptyState());
    }
  },

  startReplay: (scopeId) => {
    const state = get();
    if (!state.run) {
      return;
    }
    const run = observedRuns.get(runKey(state.run.levelId, state.run.runId));
    if (!run) {
      return;
    }
    const selected =
      (scopeId && run.scopes.has(scopeId) ? scopeId : null) ??
      run.scopeOrder.find(
        (id) => (run.scopes.get(id)?.frames.length ?? 0) > 0,
      ) ??
      null;
    if (!selected) {
      return;
    }
    set({
      mode: 'replay-playing',
      replayScopeId: selected,
      replayIndex: 0,
      replayFrame: replayFrameAt(
        state.run.levelId,
        state.run.runId,
        selected,
        0,
      ),
    });
  },

  setReplayScope: (scopeId) => {
    const state = get();
    if (!state.run) {
      return;
    }
    const run = observedRuns.get(runKey(state.run.levelId, state.run.runId));
    if (!run?.scopes.has(scopeId)) {
      return;
    }
    set({
      mode:
        state.mode === 'replay-playing' ? 'replay-playing' : 'replay-paused',
      replayScopeId: scopeId,
      replayIndex: 0,
      replayFrame: replayFrameAt(
        state.run.levelId,
        state.run.runId,
        scopeId,
        0,
      ),
    });
  },

  playReplay: () => {
    const state = get();
    if (
      !state.run ||
      !state.replayScopeId ||
      (state.mode !== 'replay-paused' && state.mode !== 'replay-playing')
    ) {
      return;
    }
    set({ mode: 'replay-playing' });
  },

  pauseReplay: () => {
    const state = get();
    if (state.mode !== 'replay-playing') {
      return;
    }
    set({ mode: 'replay-paused' });
  },

  seekReplay: (index) => {
    const state = get();
    if (!state.run || !state.replayScopeId) {
      return;
    }
    const frames = observedScope(
      state.run.levelId,
      state.run.runId,
      state.replayScopeId,
    )?.frames;
    if (!frames || frames.length === 0) {
      return;
    }
    const bounded = Math.min(frames.length - 1, Math.max(0, Math.round(index)));
    set({
      mode: 'replay-paused',
      replayIndex: bounded,
      replayFrame: replayFrameAt(
        state.run.levelId,
        state.run.runId,
        state.replayScopeId,
        bounded,
      ),
    });
  },

  advanceReplay: () => {
    const state = get();
    if (state.mode !== 'replay-playing' || !state.run || !state.replayScopeId) {
      return;
    }
    const frames = observedScope(
      state.run.levelId,
      state.run.runId,
      state.replayScopeId,
    )?.frames;
    if (!frames || frames.length === 0) {
      return;
    }
    if (state.replayIndex >= frames.length - 1) {
      set({ mode: 'replay-paused' });
      return;
    }
    const next = state.replayIndex + 1;
    set({
      replayIndex: next,
      replayFrame: replayFrameAt(
        state.run.levelId,
        state.run.runId,
        state.replayScopeId,
        next,
      ),
    });
  },

  exitReplay: () => {
    const state = get();
    if (!state.run) {
      return;
    }
    set({
      mode: 'completed',
      replayScopeId: null,
      replayIndex: 0,
      replayFrame: null,
    });
  },

  reset: () => {
    clearLiveTimers();
    observedRuns.clear();
    set(emptyState());
  },
}));
