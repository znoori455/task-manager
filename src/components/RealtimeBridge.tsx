"use client";
import { useEffect } from "react";
import { applySync, loadNotifications, receiveNotification } from "@/client/notifications";
import { startRealtime } from "@/client/realtime";

/** Starts the realtime connection and notifications once the user has a session. */
export function RealtimeBridge() {
  useEffect(() => {
    void loadNotifications();
    // After a reconnect, refetch: notifications sent while we were away weren't delivered live.
    startRealtime({ onNotification: receiveNotification, onNotificationSync: applySync, onReconnect: () => void loadNotifications() });
  }, []);
  return null;
}
