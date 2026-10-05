"use client";
import { call } from "./api";
import { countPendingEdits, discardPendingEdits, rememberName } from "./cache";
import { closeProject, useStore } from "./store";

/**
 * Sign out so someone else can pick a name. Unsent edits (e.g. made offline)
 * would be sent as the next user, so they're discarded — after confirming.
 * Then reload: the WebSocket, the event stream and all in-memory state
 * (undo history, notifications, presence) belong to the previous user.
 * Returns false if the user cancelled.
 */
export async function switchUser(): Promise<boolean> {
  const { projectId, pending: open } = useStore.getState();
  // The open project's queue is in memory (its IndexedDB copy may lag by a moment); the rest are on disk.
  const pending = open.length + (await countPendingEdits(projectId ?? undefined));
  if (pending > 0) {
    const ok = confirm(
      `You have ${pending} unsynced change${pending === 1 ? "" : "s"}. Switching users will discard ${pending === 1 ? "it" : "them"}, because ${pending === 1 ? "it" : "they"} would otherwise be sent under the new name. Continue?`,
    );
    if (!ok) return false;
  }
  // Drop every unsent edit (in memory first, so closing doesn't flush them back to disk), then stop syncing.
  useStore.setState({ pending: [] });
  closeProject();
  await discardPendingEdits();
  try {
    await call("DELETE /api/session");
  } catch {
    // Offline: the cookie isn't HttpOnly, so clear it here.
    document.cookie = "tf_user=; Path=/; Max-Age=0; SameSite=Lax";
  }
  rememberName(null);
  location.reload();
  return true;
}
