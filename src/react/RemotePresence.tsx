// Other users' cursors, drawn in screen space. The host supplies the
// model-to-screen mapping, so this works for any coordinate system.

import { styled } from "@mui/material/styles";
import type { RemotePresence } from "../client/index.js";

const Label = styled("div")(({ theme }) => ({
  position: "absolute",
  pointerEvents: "none",
  whiteSpace: "nowrap",
  fontSize: "0.65rem",
  fontWeight: 600,
  padding: "1px 5px",
  borderRadius: 3,
  backgroundColor: theme.palette.info.main,
  color: theme.palette.info.contrastText,
  transform: "translate(12px, 12px)",
}));

const CursorDot = styled("div")(({ theme }) => ({
  position: "absolute",
  width: 8,
  height: 8,
  borderRadius: "50%",
  backgroundColor: theme.palette.info.main,
  border: `1.5px solid ${theme.palette.background.default}`,
  transform: "translate(-4px, -4px)",
  pointerEvents: "none",
}));

export interface RemoteCursorsProps {
  presence: RemotePresence[];
  /** Map a model-space point to screen (viewport) pixels. */
  toScreen: (point: [number, number]) => { x: number; y: number };
  /** CSS position of the container. Default "fixed". */
  position?: "fixed" | "absolute";
  zIndex?: number;
}

export function RemoteCursors({ presence, toScreen, position = "fixed", zIndex = 1000 }: RemoteCursorsProps) {
  const withCursor = presence.filter((p) => p.cursor);
  if (withCursor.length === 0) return null;
  return (
    <>
      {withCursor.map((p) => {
        const s = toScreen(p.cursor!);
        return (
          <div key={p.userId} style={{ position, left: s.x, top: s.y, zIndex, pointerEvents: "none" }}>
            <CursorDot />
            <Label>{p.displayName}</Label>
          </div>
        );
      })}
    </>
  );
}
