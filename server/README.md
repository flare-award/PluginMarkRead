# MarkRead relay

Self-hosted WebSocket relay for the MarkRead Vencord plugin. It authenticates clients with a challenge-response signature, verifies every read receipt, deduplicates replays, rate limits clients and queues receipts for offline recipients. It never sees message content or Discord credentials.

## Quick start (local)

```bash
npm ci
npm run build
npm start
```

The relay listens on `0.0.0.0:8787` by default; set `HOST=127.0.0.1` behind a reverse proxy and adjust `PORT` as needed. For local testing the plugin accepts `ws://localhost:8787`. Without `--data-dir`, all state is in memory and lost on restart.

```bash
# health check
curl http://localhost:8787/healthz

# development
npm run dev
```

## Production

Use a TLS-terminating reverse proxy (nginx/Caddy) and point the plugin at `wss://your-domain/ws`. See [`../docs/server.md`](../docs/server.md) for systemd, nginx, Caddy, Docker, backups, limits and administration.

## Configuration

Every option is available as a CLI flag and as an environment variable; see `node dist/index.js --help` and the table in [`../docs/server.md`](../docs/server.md).

## Tests

```bash
npm test
```

Tests start a real relay on an ephemeral port and cover authentication, signature verification, tamper rejection, replay deduplication, offline delivery, rate limiting and the health endpoint.

## Protocol (v1)

1. Server sends `hello` with a random 43-character base64url challenge.
2. Client sends `auth`: `userId`, `deviceId`, `nonce`, `publicKey`, ECDSA signature over `markread-auth-v1\n<userId>\n<deviceId>\n<nonce>`, client version.
3. Server registers the key on first use (TOFU) and answers `ready` plus any queued receipts.
4. Client sends `receipt` frames containing a signed payload (`from`, `to`, `channelId`, `messageId`, `messageVersion`, `readAt`, `sentAt`, `receiptId`).
5. Server verifies the signature, the sender, the timestamps, rate limits and the replay cache, then forwards the receipt to all sessions of the recipient or queues it.
6. `watch` / `unwatch` report whether a peer is registered and online (never whether they read anything).

Frames are JSON, at most 16 KiB. All errors use the `error` frame with a stable code and a `fatal` flag. Fatal errors (`auth_failed`, `key_mismatch`, `unsupported_protocol`) make the client stop reconnecting.

## Security notes

- The registry binds a Discord user id to the first public key it ever sees. A reset requires operator action (`--reset-user`).
- Receipts for unregistered recipients are dropped instead of queued forever.
- The dedupe cache holds receipt ids for 24 hours and is bounded.
- Origin checks are optional (`ALLOWED_ORIGINS`); authentication is mandatory regardless.
- The relay logs ids, codes and counters only. It does not log frame contents.

## License

GPL-3.0-or-later.
