import { useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { formatGameDateLabel, toggleExpandedDateGroup } from '@/match-history';
import type { MatchDateGroup } from '@/match-history';

export default function MatchHistoryDateGroups({
  groups,
  renderMatch,
}: {
  groups: MatchDateGroup[];
  renderMatch: (match: MatchDateGroup['matches'][number]) => ReactNode;
}) {
  const [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set());

  function toggleDate(key: string) {
    setExpandedDates((current) => toggleExpandedDateGroup(current, key));
  }

  return <div className="history-date-list" data-testid="list-history-dates">
    {groups.map((group) => {
      const expanded = expandedDates.has(group.key);
      const panelId = `history-date-panel-${group.key}`;
      const count = group.matches.length;
      return <section className="history-date-group" key={group.key} data-testid={`group-history-date-${group.key}`}>
        <button
          type="button"
          className="history-date-trigger"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => toggleDate(group.key)}
          data-testid={`button-history-date-${group.key}`}
        >
          <CalendarDays size={18} aria-hidden="true" className="history-date-icon" />
          <span className="history-date-copy">
            <strong>{formatGameDateLabel(group.matchDate)}</strong>
            <span>{count} {count === 1 ? 'match' : 'matches'} played</span>
          </span>
          <ChevronDown size={18} aria-hidden="true" className="history-date-chevron" data-expanded={expanded} />
        </button>
        <div id={panelId} className="history-date-panel" hidden={!expanded} data-testid={`panel-history-date-${group.key}`}>
          <div className="match-list history-date-matches">
            {group.matches.map((match) => <div className="history-date-match" key={match.id}>{renderMatch(match)}</div>)}
          </div>
        </div>
      </section>;
    })}
  </div>;
}
