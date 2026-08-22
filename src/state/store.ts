/**
 * A minimal, generic pub-sub state container. Deliberately dumb: it
 * knows nothing about chess, timelines, or rendering — domain-specific
 * mutations live in state/actions.ts. This keeps "what state can exist"
 * (AppState.ts) and "what state currently exists" (this file) separate
 * from "how state legally changes" (actions.ts).
 */
export class Store<S> {
  private state: S;
  private listeners = new Set<(state: S) => void>();

  constructor(initial: S) {
    this.state = initial;
  }

  getState(): S {
    return this.state;
  }

  setState(updater: (prev: S) => S): void {
    this.state = updater(this.state);
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: (state: S) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
