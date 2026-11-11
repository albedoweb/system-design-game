/**
 * Engine-specific failures. Domain shape problems keep using
 * `DomainValidationError`; these cover run-time limits and lifecycle misuse.
 */
export class SimulationLimitError extends Error {
  readonly limit: 'arrivals' | 'events';
  readonly value: number;
  readonly maximum: number;

  constructor(limit: 'arrivals' | 'events', value: number, maximum: number) {
    super(
      limit === 'arrivals'
        ? `A stream of ${value} requests exceeds the limit of ${maximum}; reduce the level load`
        : `The simulation processed ${value} events — limit ${maximum}; the run was stopped`,
    );
    this.name = 'SimulationLimitError';
    this.limit = limit;
    this.value = value;
    this.maximum = maximum;
  }
}

export class SimulationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationInputError';
  }
}
