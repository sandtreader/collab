// Session UI: display name, join by ID, share link / QR, member list, leave.
// Styling via MUI `styled()`; colours come from the host app's theme.

import { useState, useCallback } from "react";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Dialog from "@mui/material/Dialog";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import QrCodeIcon from "@mui/icons-material/QrCode";
import LogoutIcon from "@mui/icons-material/Logout";
import LinkIcon from "@mui/icons-material/Link";
import { styled } from "@mui/material/styles";
import { QRCodeSVG } from "qrcode.react";
import type { CollabClient } from "../client/index.js";
import { useCollab } from "./useCollab.js";
import { saveDisplayName } from "./identity.js";
import { generateSessionId, isValidSessionId, parseSessionInput, sessionUrl, type SessionConfig } from "./session.js";

const Root = styled("div")({ padding: 16, display: "flex", flexDirection: "column", gap: 16 });
const Section = styled("div")({ display: "flex", flexDirection: "column", gap: 8 });
const UrlRow = styled("div")({ display: "flex", flexDirection: "column", gap: 4 });

const UrlText = styled(Typography)(({ theme }) => ({
  fontFamily: "monospace",
  fontSize: "0.75rem",
  color: theme.palette.text.secondary,
  wordBreak: "break-all",
  flex: 1,
}));

const UserList = styled("div")({ display: "flex", flexDirection: "column", gap: 4 });

const UserRow = styled("div")(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 8px",
  borderRadius: 4,
  backgroundColor: theme.palette.action.hover,
  fontSize: "0.85rem",
  color: theme.palette.text.primary,
}));

const Dot = styled("span", { shouldForwardProp: (p) => p !== "self" })<{ self?: boolean }>(({ theme, self }) => ({
  width: 8,
  height: 8,
  borderRadius: "50%",
  backgroundColor: self ? theme.palette.success.main : theme.palette.info.main,
  flexShrink: 0,
}));

export interface SessionPanelProps {
  client: CollabClient;
  config: SessionConfig;
  /** Heading text. Default "Collaborate". */
  title?: string;
}

export function SessionPanel({ client, config, title = "Collaborate" }: SessionPanelProps) {
  const { status, sessionId, users } = useCollab(client);
  const [sessionCode, setSessionCode] = useState(generateSessionId);
  const [displayName, setDisplayName] = useState(client.displayName);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const storagePrefix = config.storageKeyPrefix ?? "collab";
  const inSession = status !== "disconnected";
  const url = sessionId ? sessionUrl(config, sessionId) : "";

  const handleConnect = useCallback(() => {
    const code = parseSessionInput(sessionCode);
    if (!code) return;
    client.connect(code, config.serverUrl);
  }, [sessionCode, client, config.serverUrl]);

  const handleCopy = useCallback(() => {
    if (!url) return;
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [url]);

  const handleNameChange = useCallback((name: string) => {
    setDisplayName(name);
    client.displayName = name;
    saveDisplayName(storagePrefix, name);
  }, [client, storagePrefix]);

  return (
    <Root>
      <Typography variant="subtitle2" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: 1, fontSize: "0.7rem" }}>
        {title}
      </Typography>

      {!inSession && (
        <Section>
          <TextField
            label="Display name"
            size="small"
            value={displayName}
            onChange={(e) => handleNameChange(e.target.value)}
            variant="outlined"
            fullWidth
            slotProps={{ htmlInput: { maxLength: 24 } }}
          />
        </Section>
      )}

      {!inSession && (
        <Section>
          <TextField
            label="Session ID"
            size="small"
            placeholder="abc-defg-hij"
            value={sessionCode}
            onChange={(e) => setSessionCode(e.target.value.toLowerCase().replace(/[^a-z-]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
            error={sessionCode.trim().length > 0 && !isValidSessionId(sessionCode.trim())}
            variant="outlined"
            fullWidth
            slotProps={{ htmlInput: { maxLength: 12 } }}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={<LinkIcon />}
            onClick={handleConnect}
            disabled={!isValidSessionId(sessionCode.trim())}
          >
            Join
          </Button>
        </Section>
      )}

      {inSession && sessionId && (
        <Section>
          <Typography variant="caption" color="text.secondary">Session</Typography>
          <UrlRow>
            <UrlText>{url}</UrlText>
            <div style={{ display: "flex", gap: 4, alignSelf: "center" }}>
              <IconButton size="small" onClick={handleCopy} title={copied ? "Copied!" : "Copy URL"}>
                <ContentCopyIcon sx={{ fontSize: 16, color: copied ? "primary.main" : "text.secondary" }} />
              </IconButton>
              {(config.showQr ?? true) && (
                <IconButton size="small" onClick={() => setQrOpen(true)} title="Show QR code">
                  <QrCodeIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                </IconButton>
              )}
            </div>
          </UrlRow>
          <Typography variant="caption" color="text.secondary">
            {status === "connecting" ? "Connecting..." : status === "joining" ? "Joining..." : "Connected"}
          </Typography>
        </Section>
      )}

      {inSession && users.size > 0 && (
        <Section>
          <Typography variant="caption" color="text.secondary">Users</Typography>
          <UserList>
            {[...users.entries()]
              .sort(([a], [b]) => (a === client.userId ? -1 : b === client.userId ? 1 : 0))
              .map(([uid, name]) => {
                const self = uid === client.userId;
                return (
                  <UserRow key={uid}>
                    <Dot self={self} />
                    <span>{name}{self ? " (you)" : ""}</span>
                  </UserRow>
                );
              })}
          </UserList>
        </Section>
      )}

      {inSession && (
        <Button size="small" variant="outlined" color="error" startIcon={<LogoutIcon />} onClick={() => client.disconnect()}>
          Leave session
        </Button>
      )}

      <Dialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        maxWidth={false}
        slotProps={{
          paper: {
            sx: {
              width: "75vmin",
              height: "75vmin",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              backgroundImage: "none",
              border: "1px solid",
              borderColor: "divider",
              p: 4,
            },
          },
        }}
      >
        <QRCodeSVG
          value={url}
          size={Math.min(window.innerWidth, window.innerHeight) * 0.6}
          level="M"
          fgColor="currentColor"
          bgColor="transparent"
        />
        <Typography sx={{ fontFamily: "monospace", fontSize: "1.2rem", color: "text.secondary", textAlign: "center" }}>
          {url}
        </Typography>
      </Dialog>
    </Root>
  );
}
