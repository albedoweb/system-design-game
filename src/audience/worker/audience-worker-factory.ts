import type { AudienceWorkerFactory } from '../ui/audience-run-controller';

export const createAudienceWorker: AudienceWorkerFactory = () =>
  new Worker(new URL('./audience.worker.ts', import.meta.url), {
    type: 'module',
  });
