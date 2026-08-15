export const PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION =
  "party-autopilot-tick-boundary/v1" as const;

export type PartyAutopilotTickPhase =
  | "decision"
  | "preload"
  | "arm"
  | "transition-watchdog";

export type PartyAutopilotTickBoundary = Readonly<{
  version: typeof PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION;
  epoch: number;
  nextOperation: number;
  fatalEpoch: number | null;
}>;

export type PartyAutopilotTickTicket = Readonly<{
  version: typeof PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION;
  epoch: number;
  operation: number;
}>;

const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

const validBoundary = (boundary: PartyAutopilotTickBoundary) =>
  boundary?.version === PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION &&
  positiveSafeInteger(boundary.epoch) &&
  Number.isSafeInteger(boundary.nextOperation) && boundary.nextOperation >= 0 &&
  (boundary.fatalEpoch == null || boundary.fatalEpoch === boundary.epoch);

const validTicket = (ticket: PartyAutopilotTickTicket) =>
  ticket?.version === PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION &&
  positiveSafeInteger(ticket.epoch) && positiveSafeInteger(ticket.operation);

export const createPartyAutopilotTickBoundary = (): PartyAutopilotTickBoundary => Object.freeze({
  version: PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION,
  epoch: 1,
  nextOperation: 0,
  fatalEpoch: null
});

export const advancePartyAutopilotTickEpoch = (
  current: PartyAutopilotTickBoundary
): PartyAutopilotTickBoundary => {
  if (!validBoundary(current) || current.epoch >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Autopilot tick epoch cannot advance");
  }
  return Object.freeze({
    version: PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION,
    epoch: current.epoch + 1,
    nextOperation: current.nextOperation,
    fatalEpoch: null
  });
};

export const issuePartyAutopilotTick = (
  current: PartyAutopilotTickBoundary
): Readonly<{ boundary: PartyAutopilotTickBoundary; ticket: PartyAutopilotTickTicket }> => {
  if (!validBoundary(current) || current.nextOperation >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Autopilot tick operation cannot advance");
  }
  const operation = current.nextOperation + 1;
  return Object.freeze({
    boundary: Object.freeze({ ...current, nextOperation: operation }),
    ticket: Object.freeze({
      version: PARTY_AUTOPILOT_TICK_BOUNDARY_VERSION,
      epoch: current.epoch,
      operation
    })
  });
};

export const ownsPartyAutopilotTick = (
  current: PartyAutopilotTickBoundary,
  ticket: PartyAutopilotTickTicket | null | undefined
) => Boolean(validBoundary(current) && ticket && validTicket(ticket) &&
  current.epoch === ticket.epoch && current.fatalEpoch !== current.epoch &&
  ticket.operation <= current.nextOperation);

export const claimPartyAutopilotTickFailure = (
  current: PartyAutopilotTickBoundary,
  ticket: PartyAutopilotTickTicket
): Readonly<{ boundary: PartyAutopilotTickBoundary; claimed: boolean }> => {
  if (!ownsPartyAutopilotTick(current, ticket)) {
    return Object.freeze({ boundary: current, claimed: false });
  }
  return Object.freeze({
    boundary: Object.freeze({ ...current, fatalEpoch: current.epoch }),
    claimed: true
  });
};

const TICK_PHASES: readonly PartyAutopilotTickPhase[] = Object.freeze([
  "decision",
  "preload",
  "arm",
  "transition-watchdog"
]);

export const runPartyAutopilotTickTask = async (input: Readonly<{
  task: (setPhase: (phase: PartyAutopilotTickPhase) => void) => Promise<void>;
  onFailure: (phase: PartyAutopilotTickPhase) => void | Promise<void>;
}>) => {
  let phase: PartyAutopilotTickPhase = "decision";
  const setPhase = (next: PartyAutopilotTickPhase) => {
    if (!TICK_PHASES.includes(next)) throw new RangeError("invalid Autopilot tick phase");
    phase = next;
  };
  try {
    await input.task(setPhase);
  } catch {
    try {
      await input.onFailure(phase);
    } catch {
      // The fatal boundary is deliberately terminal: a reporting/cleanup
      // failure must not escape as another unhandled coordinator rejection.
    }
  }
};
