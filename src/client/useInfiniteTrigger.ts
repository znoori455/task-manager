"use client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect } from "react";
import type { Feed } from "./feeds";

/** Fetch the next page when the virtualized list is within `threshold` rows of the end. */
export function useInfiniteTrigger(virtualizer: Virtualizer<HTMLDivElement, Element>, feed: Feed, threshold = 10) {
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;
  const { ids, hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= ids.length - threshold) fetchNextPage();
  }, [lastIndex, ids.length, hasNextPage, isFetchingNextPage, fetchNextPage, threshold]);
}
