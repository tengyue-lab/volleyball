import { createContext, useContext, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Match } from '@workspace/api-client-react';
import { freshSession, nextSession } from './match-session';
import type { MatchSession } from './match-session';

const SessionContext = createContext<{
  draft: MatchSession;
  setDraft: Dispatch<SetStateAction<MatchSession>>;
  startNext: (match: Match) => void;
  startOver: () => void;
  replaceSession: (build: (generation: number) => MatchSession) => void;
} | null>(null);

// AuthBridge remounts its children on identity/access changes, clearing this
// in-memory handoff. Nothing is written to browser storage or URL player lists.
export function MatchSessionProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(() => freshSession());
  return <SessionContext.Provider value={{
    draft, setDraft,
    startNext: (match) => setDraft((current) => nextSession(match, current.generation + 1)),
    startOver: () => setDraft((current) => freshSession(current.generation + 1)),
    replaceSession: (build) => setDraft((current) => build(current.generation + 1)),
  }}>{children}</SessionContext.Provider>;
}

export function useMatchSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('Match session provider is missing.');
  return context;
}
