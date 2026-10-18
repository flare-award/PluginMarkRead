/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { Alerts, ChannelStore, React, showToast, UserStore } from "@webpack/common";

import { getIdentity, getIdentityFingerprint } from "../core/identity";
import { clearLocalData } from "../core/persistence";
import { getConnection } from "../core/runtime";
import { optOutStore, pinnedPeers } from "../core/state";
import { fingerprintPublicKey, PROTOCOL_VERSION } from "../protocol";
import { useConnectionState, useOptOutChannels, usePinnedPeers, useSettings } from "./hooks";

const PHASE_TEXT: Record<string, string> = {
    disabled: "Disabled",
    not_configured: "Not configured",
    connecting: "Connecting…",
    authenticating: "Authenticating…",
    online: "Connected",
    reconnecting: "Reconnecting…",
    error: "Error"
};

const ERROR_TEXT: Record<string, string> = {
    not_configured: "No relay URL is set.",
    invalid_url: "The relay URL is not valid.",
    credentials_not_allowed: "The relay URL must not contain a username or password.",
    hash_not_allowed: "The relay URL must not contain a fragment.",
    invalid_protocol: "Only wss:// URLs are supported (ws:// only for loopback).",
    insecure_transport: "Unencrypted ws:// is only allowed for localhost.",
    connection_failed: "Could not open a connection to the relay.",
    connection_closed: "The relay closed the connection.",
    auth_timeout: "The relay did not complete authentication in time.",
    identity_unavailable: "The local encryption key could not be loaded.",
    unsupported_protocol: "The relay speaks an unsupported protocol version.",
    auth_failed: "The relay rejected the authentication signature.",
    key_mismatch: "Another key is registered for your Discord account on this relay. Ask the relay operator to reset it.",
    too_many_connections: "Too many simultaneous connections for this account.",
    rate_limited: "The relay is rate limiting this client.",
    origin_not_allowed: "This client's origin is not allowed by the relay.",
    server_shutting_down: "The relay is shutting down.",
    pong_timeout: "The relay stopped answering."
};

function displayUser(userId: string): string {
    const user = UserStore.getUser(userId);
    return user ? `${user.globalName || user.username} (${userId})` : userId;
}

function displayChannel(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    const peerId = channel?.recipients?.[0];
    return peerId ? `DM with ${displayUser(peerId)}` : channelId;
}

export function SettingsPanel() {
    const settings = useSettings();
    const connection = useConnectionState();
    const pins = usePinnedPeers();
    const optOuts = useOptOutChannels();

    const [identityFingerprint, setIdentityFingerprint] = React.useState("");
    const [identityStorage, setIdentityStorage] = React.useState("");
    const [pinFingerprints, setPinFingerprints] = React.useState<Record<string, string>>({});

    React.useEffect(() => {
        let alive = true;

        getIdentityFingerprint()
            .then(value => {
                if (alive) setIdentityFingerprint(value);
            })
            .catch(() => {
                if (alive) setIdentityFingerprint("unavailable");
            });

        getIdentity()
            .then(identity => {
                if (alive) setIdentityStorage(identity.storage);
            })
            .catch(() => {
                if (alive) setIdentityStorage("unavailable");
            });

        return () => {
            alive = false;
        };
    }, []);

    const pinsKey = pins.map(pin => `${pin.userId}:${pin.publicKey}`).join("|");
    React.useEffect(() => {
        let alive = true;

        Promise.all(pins.map(async pin => [pin.userId, await fingerprintPublicKey(pin.publicKey)] as const))
            .then(entries => {
                if (alive) setPinFingerprints(Object.fromEntries(entries));
            })
            .catch(() => {
                if (alive) setPinFingerprints({});
            });

        return () => {
            alive = false;
        };
    }, [pinsKey]);

    const statusText = PHASE_TEXT[connection.phase] ?? connection.phase;
    const errorText = connection.error ? (ERROR_TEXT[connection.error] ?? connection.error) : undefined;

    return (
        <div className="vc-markread-settings">
            <Heading tag="h5">MarkRead</Heading>
            <Paragraph>
                Cooperative read confirmations for 1:1 DMs. Discord does not expose read state, so both
                participants must run MarkRead, connect to the same relay and enable receipt exchange.
                A confirmation is only created after the recipient kept the message visible in a
                focused Discord window for the configured dwell time.
            </Paragraph>

            <Divider />
            <Heading tag="h5">Relay connection</Heading>
            <Paragraph>
                Status: <strong>{statusText}</strong>
                {connection.url ? <> — <code>{connection.url}</code></> : null}
            </Paragraph>
            {errorText && <Paragraph>Last error: <strong>{errorText}</strong></Paragraph>}
            {connection.phase === "reconnecting" && connection.nextRetryAt != null && (
                <Paragraph>Next attempt: {new Date(connection.nextRetryAt).toLocaleTimeString()}</Paragraph>
            )}
            {!settings.exchangeEnabled && (
                <Paragraph>Receipt exchange is disabled. Enable it in the plugin settings above to connect.</Paragraph>
            )}
            {settings.exchangeEnabled && !settings.serverUrl.trim() && (
                <Paragraph>Set the relay URL above to connect.</Paragraph>
            )}
            {settings.exchangeEnabled && !settings.shareReadReceipts && (
                <Paragraph>You will receive confirmations, but your own read state is not shared.</Paragraph>
            )}
            <div className="vc-markread-actions">
                <Button size="small" variant="secondary" onClick={() => getConnection()?.reconnectNow()}>
                    Reconnect now
                </Button>
            </div>

            <Divider />
            <Heading tag="h5">Your identity</Heading>
            <Paragraph>
                Fingerprint: <strong>{identityFingerprint || "loading…"}</strong>
            </Paragraph>
            {identityStorage === "jwk-fallback" && (
                <Paragraph>
                    Warning: this environment does not support non-extractable keys, so MarkRead stores
                    an extractable local key instead. Malware running on this machine could copy it.
                </Paragraph>
            )}
            <div className="vc-markread-actions">
                <Button
                    size="small"
                    variant="secondary"
                    disabled={!identityFingerprint || identityFingerprint === "unavailable"}
                    onClick={() => copyWithToast(identityFingerprint)}
                >
                    Copy my fingerprint
                </Button>
                <Button
                    size="small"
                    variant="dangerSecondary"
                    onClick={async () => {
                        const ok = await Alerts.confirm({
                            title: "Reset MarkRead identity?",
                            body: "A new key pair will be generated and the relay will reject it until its operator clears the old registration. Existing confirmations stay on disk unless you delete them separately.",
                            confirmText: "Reset identity",
                            cancelText: "Cancel",
                            confirmColor: "red"
                        });
                        if (!ok) return;

                        await clearLocalData({ includeIdentity: true });
                        getConnection()?.reconnectNow();
                        showToast({ text: "MarkRead identity reset", variant: "success" });
                    }}
                >
                    Reset identity
                </Button>
            </div>

            <Divider />
            <Heading tag="h5">Trusted peer keys</Heading>
            <Paragraph>
                MarkRead pins the first signing key it sees for every peer. Compare fingerprints with
                your contact over a trusted channel to rule out a malicious relay.
            </Paragraph>
            {pins.length === 0
                ? <Paragraph>No peer keys have been pinned yet.</Paragraph>
                : (
                    <div className="vc-markread-list">
                        {pins.map(pin => (
                            <div className="vc-markread-list-row" key={pin.userId}>
                                <span>
                                    {displayUser(pin.userId)}
                                    <br />
                                    <code>{pinFingerprints[pin.userId] ?? "…"}</code>
                                </span>
                                <Button size="small" variant="secondary" onClick={() => pinnedPeers.forget(pin.userId)}>
                                    Forget key
                                </Button>
                            </div>
                        ))}
                    </div>
                )}

            <Divider />
            <Heading tag="h5">Disabled conversations</Heading>
            {optOuts.length === 0
                ? <Paragraph>Confirmations are enabled in every DM. Use the DM context menu to disable one.</Paragraph>
                : (
                    <div className="vc-markread-list">
                        {optOuts.map(channelId => (
                            <div className="vc-markread-list-row" key={channelId}>
                                <span>{displayChannel(channelId)}</span>
                                <Button size="small" variant="secondary" onClick={() => optOutStore.remove(channelId)}>
                                    Enable
                                </Button>
                            </div>
                        ))}
                    </div>
                )}

            <Divider />
            <Heading tag="h5">Local data</Heading>
            <Paragraph>
                Stored locally: verified confirmations (message and channel ids, read and arrival
                times), a deduplication log, per-DM opt-outs, pinned peer keys and your identity key.
                Message contents, attachments and Discord credentials are never stored or sent by
                MarkRead.
            </Paragraph>
            <div className="vc-markread-actions">
                <Button
                    size="small"
                    variant="dangerSecondary"
                    onClick={async () => {
                        const ok = await Alerts.confirm({
                            title: "Delete confirmation data?",
                            body: "Removes locally stored confirmations, the deduplication log, disabled conversations and pinned peer keys. Your identity key is kept.",
                            confirmText: "Delete data",
                            cancelText: "Cancel",
                            confirmColor: "red"
                        });
                        if (!ok) return;

                        await clearLocalData({ includeIdentity: false });
                        showToast({ text: "MarkRead data deleted", variant: "success" });
                    }}
                >
                    Delete confirmation data
                </Button>
                <Button
                    size="small"
                    variant="dangerPrimary"
                    onClick={async () => {
                        const ok = await Alerts.confirm({
                            title: "Delete all MarkRead data?",
                            body: "This also deletes your identity key and device id. Peers will no longer be able to verify old confirmations from this client.",
                            confirmText: "Delete everything",
                            cancelText: "Cancel",
                            confirmColor: "red"
                        });
                        if (!ok) return;

                        await clearLocalData({ includeIdentity: true });
                        getConnection()?.reconnectNow();
                        showToast({ text: "All MarkRead data deleted", variant: "success" });
                    }}
                >
                    Delete everything
                </Button>
            </div>

            <Divider />
            <Paragraph>
                Protocol version {PROTOCOL_VERSION}. No telemetry and no analytics. The relay necessarily
                sees connection metadata: Discord user ids, a random device id, your IP address, and the
                channel/message ids of confirmations. It never sees message content.
            </Paragraph>
        </div>
    );
}
