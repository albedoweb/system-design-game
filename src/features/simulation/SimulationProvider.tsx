import { useEffect, useState, type ReactNode } from 'react';

import { useSessionStore } from '../../state/session-store';
import {
  createSimulationController,
  type SimulationControllerOptions,
} from './simulation-controller';
import { SimulationContext } from './simulation-context';

export function SimulationProvider({
  children,
  options,
}: {
  children: ReactNode;
  options?: SimulationControllerOptions;
}) {
  const [controller] = useState(() => createSimulationController(options));

  useEffect(() => {
    return () => {
      controller.dispose();
      useSessionStore.getState().reset();
    };
  }, [controller]);

  return (
    <SimulationContext.Provider value={controller}>
      {children}
    </SimulationContext.Provider>
  );
}
