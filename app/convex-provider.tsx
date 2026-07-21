"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState, type ReactNode } from "react";

// Wraps the app so client components can run reactive Convex queries. One client
// per browser session; the URL is public (NEXT_PUBLIC_) and points at the local
// deployment in dev, the cloud deployment in production.
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
    return new ConvexReactClient(url);
  });
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
