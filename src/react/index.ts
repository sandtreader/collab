// @sandtreader/collab — react
//
// Session UI and presence rendering. Peer-depends on React, MUI,
// qrcode.react and bad-words.

export { SessionPanel, type SessionPanelProps } from "./SessionPanel.js";
export { RemoteCursors, type RemoteCursorsProps } from "./RemotePresence.js";
export { useCollab, type CollabSnapshot } from "./useCollab.js";
export { getOrCreateUserId, getOrCreateDisplayName, saveDisplayName, randomDisplayName } from "./identity.js";
export {
  autoJoinFromUrl,
  generateSessionId,
  isValidSessionId,
  parseSessionInput,
  sessionFromPath,
  sessionUrl,
  SESSION_ID_REGEX,
  type SessionConfig,
} from "./session.js";
