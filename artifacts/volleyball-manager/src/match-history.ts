import type { Match } from '@workspace/api-client-react';

export interface MatchDateGroup {
  key: string;
  matchDate: string | null;
  matches: Match[];
}

const LEGACY_DATE_KEY = 'date-not-recorded';
const ISO_LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function localDateFromKey(value: string): Date | null {
  const parts = ISO_LOCAL_DATE.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const localDate = new Date(year, month - 1, day, 12);
  if (
    localDate.getFullYear() !== year
    || localDate.getMonth() !== month - 1
    || localDate.getDate() !== day
  ) return null;
  return localDate;
}

function normalizeMatchDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return localDateFromKey(value) ? value : null;
}

export function groupCompletedMatchesByGameDate(matches: Match[]): MatchDateGroup[] {
  const groups = new Map<string, MatchDateGroup>();
  for (const match of matches) {
    if (match.status !== 'completed') continue;
    const matchDate = normalizeMatchDate(match.matchDate);
    const key = matchDate ?? LEGACY_DATE_KEY;
    const group = groups.get(key) ?? { key, matchDate, matches: [] };
    group.matches.push(match);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.matchDate === null) return b.matchDate === null ? 0 : 1;
    if (b.matchDate === null) return -1;
    return b.matchDate.localeCompare(a.matchDate);
  });
}

export function formatGameDateLabel(matchDate: string | null): string {
  if (!matchDate) return 'Date not recorded';
  const localDate = localDateFromKey(matchDate);
  if (!localDate) return 'Date not recorded';
  const weekday = new Intl.DateTimeFormat('en-AU', { weekday: 'long' }).format(localDate);
  const calendarDate = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(localDate);
  return `${weekday}, ${calendarDate}`;
}

export function formatMatchCardDate(matchDate: string | null, createdAt: string): string {
  const date = localDateFromKey(matchDate ?? '') ?? new Date(createdAt);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function toggleExpandedDateGroup(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
