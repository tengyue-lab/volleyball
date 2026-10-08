"""Authoritative rating progression; current player ranks are derived, not stored."""

STARTING_ELO = 800
PLACEMENT_MATCHES = 10
RANK_THRESHOLDS = (
    (0, "Iron 3"), (600, "Iron 2"), (700, "Iron 1"),
    (800, "Bronze 3"), (900, "Bronze 2"), (1000, "Bronze 1"),
    (1100, "Silver 3"), (1200, "Silver 2"), (1300, "Silver 1"),
    (1400, "Gold 3"), (1500, "Gold 2"), (1600, "Gold 1"),
    (1700, "Platinum 3"), (1800, "Platinum 2"), (1900, "Platinum 1"),
    (2000, "Diamond 3"), (2100, "Diamond 2"), (2200, "Diamond 1"),
    (2300, "Masters"),
)
RANK_ORDER = {label: index for index, (_, label) in enumerate(RANK_THRESHOLDS)}


def rank_for_elo(elo: int) -> str:
    for minimum, label in reversed(RANK_THRESHOLDS):
        if elo >= minimum:
            return label
    raise ValueError("ELO must be nonnegative.")


def tier_for_elo(elo: int) -> str:
    """Return the existing rank tier without its division, where applicable."""
    return rank_for_elo(elo).split(" ", 1)[0]


def tier_elo_ranges() -> list[dict[str, int | str | None]]:
    """Collapse the existing division thresholds into display-tier ranges."""
    tier_starts: list[tuple[int, str]] = []
    for minimum, label in RANK_THRESHOLDS:
        tier = label.split(" ", 1)[0]
        if not tier_starts or tier_starts[-1][1] != tier:
            tier_starts.append((minimum, tier))

    return [
        {
            "tier": tier,
            "minElo": minimum,
            "maxElo": tier_starts[index + 1][0] - 1 if index + 1 < len(tier_starts) else None,
        }
        for index, (minimum, tier) in enumerate(tier_starts)
    ]


def k_for_matches(matches_played: int) -> int:
    """Count BEFORE this result: the tenth placement match still uses K=60."""
    if matches_played < 0:
        raise ValueError("Matches played must be nonnegative.")
    if matches_played < 10:
        return 60
    if matches_played < 30:
        return 40
    if matches_played < 60:
        return 32
    return 20


def is_provisional(matches_played: int) -> bool:
    return matches_played < PLACEMENT_MATCHES


def rank_movement(before: str | None, after: str | None) -> str | None:
    if before not in RANK_ORDER or after not in RANK_ORDER:
        return None  # Legacy rows never recorded rank metadata.
    difference = RANK_ORDER[after] - RANK_ORDER[before]
    return "promotion" if difference > 0 else "demotion" if difference < 0 else "unchanged"
