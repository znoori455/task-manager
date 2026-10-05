"use client";
// One shared draft of a task's description (Yjs), synced through the realtime
// service. The draft is ephemeral; the saved description is whatever the
// editor autosaves through the normal command pipeline.
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { registerDoc, sendDoc } from "./realtime";

const REMOTE = "remote";
const toB64 = (u: Uint8Array) => btoa(Array.from(u, (b) => String.fromCharCode(b)).join(""));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface DescriptionSession {
  doc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
  /** Resolves once the server's draft has been loaded (the editor mounts then). */
  ready: Promise<void>;
  destroy: () => void;
}

/**
 * Join the shared draft for `taskId`. `seed` is the saved description: it
 * becomes the draft only if none exists yet (the server makes sure exactly one
 * seed wins). `onReset` fires if the draft we were editing was replaced by a new
 * one (it expired while we were disconnected): the caller must start a fresh
 * session, because merging two independently seeded drafts would duplicate text.
 */
export function openDescriptionSession(
  taskId: string,
  seed: string,
  user: { name: string; color: string },
  onReset: () => void,
): DescriptionSession {
  const doc = new Y.Doc();
  const text = doc.getText("description");
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", { name: user.name, color: user.color, colorLight: `${user.color}33` });

  let generation: string | null = null;
  let destroyed = false;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  const join = () => sendDoc({ type: "doc.join", taskId, seed: currentSeed(), clientId: doc.clientID });
  // After the first sync, rejoining offers our current text as the seed (used only if the draft expired).
  const currentSeed = () => (generation ? text.toString() : seed);

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE && generation) sendDoc({ type: "doc.update", taskId, generation, update: toB64(update) });
  };
  doc.on("update", onDocUpdate);

  const onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === REMOTE) return;
    const changed = [...added, ...updated, ...removed];
    sendDoc({ type: "doc.awareness", taskId, update: toB64(encodeAwarenessUpdate(awareness, changed)) });
  };
  awareness.on("update", onAwarenessUpdate);

  const unregister = registerDoc(taskId, {
    onSync(gen, state) {
      if (destroyed) return;
      if (generation && gen !== generation) {
        onReset();
        return;
      }
      const first = !generation;
      generation = gen;
      Y.applyUpdate(doc, fromB64(state), REMOTE);
      if (first) markReady();
      else {
        // Rejoined the same draft after a reconnect: send anything we typed while disconnected (CRDT merge is idempotent).
        sendDoc({ type: "doc.update", taskId, generation: gen, update: toB64(Y.encodeStateAsUpdate(doc)) });
      }
      // Re-announce our caret to whoever is there now.
      onAwarenessUpdate({ added: [], updated: [doc.clientID], removed: [] }, null);
    },
    onUpdate(update) {
      Y.applyUpdate(doc, fromB64(update), REMOTE);
    },
    onAwareness(update) {
      // Carets are cosmetic: a malformed one from a peer must not break the editor.
      try {
        applyAwarenessUpdate(awareness, fromB64(update), REMOTE);
      } catch (e) {
        console.warn("[collab] ignored a bad caret update", e);
      }
    },
    onPeerLeft(clientId) {
      removeAwarenessStates(awareness, [clientId], REMOTE);
    },
    onReconnect: join,
  });
  join();

  return {
    doc,
    text,
    awareness,
    ready,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      awareness.setLocalState(null); // tells peers to remove our caret
      sendDoc({ type: "doc.leave", taskId });
      unregister();
      awareness.off("update", onAwarenessUpdate);
      doc.off("update", onDocUpdate);
      awareness.destroy();
      doc.destroy();
    },
  };
}
