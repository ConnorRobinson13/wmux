"use strict";
/**
 * How long a wmux client waits for the pipe, derived from the transport rather
 * than written down per client.
 *
 * Two processes talk to wmux over the same socket: the CLI (`wmux.ts`) and the
 * Claude Code hook helper (`wmux-hook.ts`). Both had their own copy of the same
 * pair of numbers and their own idea of when to use which — the CLI derived it
 * from `remoteTarget || usesNpiperelay()`, the hook hardcoded
 * `remote ? 30000 : 5000`. Same intent, two spellings, and only one of them
 * knew about npiperelay. A third client, or a change to either number, would
 * have had to find both.
 *
 * So the transport describes itself and the deadline follows. Nothing here does
 * I/O; the caller supplies what it already knows about its own connection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SLOW_TRANSPORT_FLOOR_MS = exports.DEFAULT_V2_TIMEOUT_MS = void 0;
exports.isWslHost = isWslHost;
exports.usesNpiperelay = usesNpiperelay;
exports.isSlowTransport = isSlowTransport;
exports.transportDeadline = transportDeadline;
/**
 * What a local named pipe on the same machine is worth waiting.
 *
 * Sized for a round-trip that is sub-millisecond, so the whole budget is the
 * server's own thinking time. This deadline has to stay LARGER than whatever
 * the main process spends serving the same request, or the client loses a race
 * it should never have been in: a command that succeeds late is reported as a
 * failure and the server's own diagnosis is discarded unread.
 */
exports.DEFAULT_V2_TIMEOUT_MS = 5000;
/**
 * A floor under every deadline, for transports slower than a local pipe.
 *
 * Neither transport added for issue #19 is a local pipe: TCP to a `wmux bridge`
 * from inside a devcontainer, and npiperelay over WSL interop. Both measure ~7s
 * worst case on a corporate-managed host — above the 5s default on their own,
 * before wmux has done anything — so every request from a container reported a
 * timeout for a call that had already succeeded.
 *
 * A floor rather than a replacement, so a browser verb keeps the longer budget
 * it asked for and a local run keeps its original timings exactly.
 */
exports.SLOW_TRANSPORT_FLOOR_MS = 30000;
/**
 * Is this process running INSIDE a WSL distro (#288)?
 *
 * The env vars alone cannot say: Windows Terminal exports
 * `WSLENV=WT_SESSION:WT_PROFILE_ID:` to EVERY process it starts, WSL or not, so
 * a native Windows `wmux ping` from a Windows Terminal tab took the npiperelay
 * branch and failed with "npiperelay.exe not found" — and an agent outside
 * wmux, following the agent-context block's absolute-path check, concluded
 * wmux was absent. Node inside WSL reports `linux`; a native Windows process
 * reports `win32` whatever its environment says, and never needs a relay to
 * reach a named pipe on its own machine.
 */
function isWslHost(env, platform = process.platform) {
    return platform !== 'win32' && Boolean(env.WSL_DISTRO_NAME || env.WSLENV);
}
/**
 * Whether the local hop goes through npiperelay.exe over WSL interop.
 *
 * A Windows pipe path (`\\.\pipe\wmux`, not something rooted at `/`) reached
 * from inside a WSL distro cannot be dialled directly — npiperelay is what
 * bridges it, and spawning a Windows executable over interop is the slow part,
 * especially where AV scans the binary on each exec.
 */
function usesNpiperelay(t) {
    return !t.remote && !t.pipePath.startsWith('/') && isWslHost(t.env, t.platform);
}
/** Whether this transport needs the floor at all. */
function isSlowTransport(t) {
    return t.remote || usesNpiperelay(t);
}
/**
 * `base`, raised to the slow-transport floor when the transport is a slow one.
 *
 * `WMUX_RPC_TIMEOUT_MS` overrides the floor for anyone whose link is slower
 * still, and is itself a floor rather than a cap — it can only ever lengthen a
 * deadline, so setting it can never cause the truncation this exists to avoid.
 */
function transportDeadline(base, t) {
    const override = parseInt(t.env.WMUX_RPC_TIMEOUT_MS || '', 10);
    if (Number.isFinite(override) && override > 0)
        return Math.max(base, override);
    return isSlowTransport(t) ? Math.max(base, exports.SLOW_TRANSPORT_FLOOR_MS) : base;
}
