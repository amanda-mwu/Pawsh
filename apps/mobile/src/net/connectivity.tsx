import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

export interface Connectivity {
  /** False only when the device reports no usable connection. Unknown counts as online. */
  online: boolean;
}

/**
 * Optimistic by default.
 *
 * NetInfo reports `isInternetReachable: null` while it is still probing, and treating that as
 * offline would flash the banner on every cold start. A request that fails for connectivity is
 * the authoritative signal; this is a hint used to phrase things well.
 */
export const ConnectivityContext = createContext<Connectivity>({ online: true });

export function ConnectivityProvider({
  children
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const reachable = state.isInternetReachable;
      setOnline(state.isConnected !== false && reachable !== false);
    });
    return unsubscribe;
  }, []);

  const value = useMemo(() => ({ online }), [online]);
  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): Connectivity {
  return useContext(ConnectivityContext);
}
