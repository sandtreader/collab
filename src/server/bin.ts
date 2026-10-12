#!/usr/bin/env node
// collab-relay — run the relay as a standalone process.
//
//   PORT=2901 collab-relay

import { createRelay } from "./index.js";

const port = Number(process.env.PORT ?? 2901);
const relay = createRelay({ port, log: (line) => console.log(line) });

console.log(`collab-relay listening on port ${port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    relay.close().then(() => process.exit(0));
  });
}
