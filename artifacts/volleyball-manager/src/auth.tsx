import { createContext, Fragment, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthViewerQueryKey, useGetAuthViewer } from '@workspace/api-client-react';
import type { Player } from '@workspace/api-client-react';

export type RatedPlayer = Player & { elo: number };
export function isRatedPlayer(player: Player): player is RatedPlayer {
  return typeof player.elo === 'number';
}

export interface Access {
  status: 'loading' | 'ready' | 'error';
  signedIn: boolean;
  isAdmin: boolean;
  playerId: number | null;
  email: string | null;
  retry: () => void;
}

const failClosed: Access = { status: 'loading', signedIn: false, isAdmin: false, playerId: null, email: null, retry: () => {} };
const AccessContext = createContext<Access>(failClosed);
export const useAccess = () => useContext(AccessContext);

export function AuthBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const uid: string | null | undefined = !isLoaded ? undefined : isSignedIn ? (userId ?? null) : null;
  const [settledUid, setSettledUid] = useState<string | null | undefined>(undefined);
  const prevUid = useRef<string | null | undefined>(undefined);
  const ready = uid !== undefined && settledUid === uid;

  const viewer = useGetAuthViewer({
    query: { queryKey: getGetAuthViewerQueryKey(), enabled: ready && uid !== null, refetchInterval: 5000, staleTime: 0, retry: false },
  });

  const access: Access = useMemo(() => {
    const retry = () => { void viewer.refetch(); };
    if (!ready) return { ...failClosed, retry };
    if (uid === null) return { status: 'ready', signedIn: false, isAdmin: false, playerId: null, email: null, retry };
    const data = viewer.data;
    const valid = !!data && data.signedIn && data.userId === uid;
    if (viewer.isError || (data && !valid && !viewer.isFetching)) return { status: 'error', signedIn: true, isAdmin: false, playerId: null, email: null, retry };
    if (!valid || !data) return { ...failClosed, signedIn: true, retry };
    return { status: 'ready', signedIn: true, isAdmin: data.isAdmin, playerId: data.playerId, email: data.email, retry };
  }, [ready, uid, viewer.data, viewer.isError, viewer.isFetching, viewer]);

  const identityKey = `${uid ?? 'anon'}|${access.status === 'ready' ? access.isAdmin : access.status}|${access.playerId ?? 'none'}`;
  const prevKey = useRef<string | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (uid === undefined) return;
    if (prevUid.current !== undefined && prevUid.current !== uid) {
      void queryClient.cancelQueries();
      queryClient.clear();
    }
    prevUid.current = uid;
    setSettledUid(uid);
  }, [uid, queryClient]);

  useLayoutEffect(() => {
    if (prevKey.current !== null && prevKey.current !== identityKey) {
      const viewerKey = getGetAuthViewerQueryKey()[0];
      void queryClient.cancelQueries({ predicate: (q) => q.queryKey[0] !== viewerKey });
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== viewerKey });
    }
    prevKey.current = identityKey;
    setSettledKey(identityKey);
  }, [identityKey, queryClient]);

  const showChildren = ready && settledKey === identityKey && (access.status !== 'loading');
  return <AccessContext.Provider value={access}>
    {showChildren ? <Fragment key={identityKey}>{children}</Fragment> : <div className="auth-loading" role="status">Checking your access…</div>}
  </AccessContext.Provider>;
}
