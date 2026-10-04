"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useEffect, useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Live data arrives over SSE, so queries never go stale on their own.
        defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1 } },
      }),
  );

  useEffect(() => {
    // The service worker caches the app shell so the app opens without a network.
    // Production only: in dev it would fight with hot reloading.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("[sw]", e));
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/* Floating panel to inspect cached query keys and data. Renders nothing in production builds. */}
      <ReactQueryDevtools buttonPosition="bottom-right" />
    </QueryClientProvider>
  );
}
