import type { ScoreboardWorkerFactory } from '../ui/scoreboard-run-controller';

export const createScoreboardWorker: ScoreboardWorkerFactory = () =>
  new Worker(new URL('./scoreboard.worker.ts', import.meta.url), {
    type: 'module',
  });
