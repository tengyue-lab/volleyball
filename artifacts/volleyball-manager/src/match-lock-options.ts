import { MATCH_POSITIONS } from './match-balancing.ts';
import type { MatchPosition } from './match-balancing.ts';

export function preferredLockPositions(preferences: readonly string[]): MatchPosition[] {
  return preferences.filter(
    (position): position is MatchPosition => MATCH_POSITIONS.includes(position as MatchPosition),
  );
}
