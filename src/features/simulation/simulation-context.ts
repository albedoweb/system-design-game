import { createContext, useContext } from 'react';

import type { SimulationController } from './simulation-controller';

export const SimulationContext = createContext<SimulationController | null>(null);

export function useSimulation(): SimulationController {
  const controller = useContext(SimulationContext);
  if (!controller) {
    throw new Error('useSimulation must be used inside SimulationProvider');
  }
  return controller;
}
