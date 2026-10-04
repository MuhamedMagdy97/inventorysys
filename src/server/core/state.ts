import { AppError } from "./errors";

// Doc 23 state machines. Each document declares its allowed moves once; every
// transition checks them here and then compare-and-increments `version` with
// `updateMany({ where: { id, version, status: from } })` + assertVersion (INV-023).
// An invalid move is `invalid_transition` (execute() audits it as transition.denied).
export function stateMachine<S extends string>(entity: string, next: Record<S, readonly S[]>) {
  return {
    assert(from: S, to: S) {
      if (!next[from].includes(to)) {
        throw new AppError("invalid_transition", `${entity} can't go from ${from} to ${to}`, { from, to });
      }
    },
    can: (from: S, to: S) => next[from].includes(to),
  };
}
