import type { PlayerUpdate } from '@workspace/api-client-react';

export interface RatingAdjustmentIntent {
  signature: string;
  key: string;
}

/** Name/preference edits must not send a stale unchanged rating from the form. */
export function playerEditFields(
  name: string, positions: PlayerUpdate['positions'], eloPublic: boolean,
  rating: number, initialRating: number | null,
): PlayerUpdate {
  return { name, positions, eloPublic, ...(rating !== initialRating ? { elo: rating } : {}) };
}

/** One key per edit intent, not per HTTP attempt. Never mutate the form values. */
export function prepareRatingAdjustment(
  playerId: number,
  fields: PlayerUpdate,
  previous: RatingAdjustmentIntent | null,
  createKey: () => string = () => crypto.randomUUID(),
) {
  const { adjustmentRequestId: _ignored, ...changes } = fields;
  const canonical = Object.fromEntries(Object.entries(changes).sort(([a], [b]) => a.localeCompare(b)));
  const signature = JSON.stringify({ playerId, changes: canonical });
  const intent = previous?.signature === signature ? previous : { signature, key: createKey() };
  return { data: { ...changes, adjustmentRequestId: intent.key }, intent };
}
