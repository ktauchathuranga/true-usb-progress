/**
 * True USB Write Progress — GNOME Shell Extension
 * UUID : true-usb-progress@ktauchathuranga.github.io
 *
 * Monitors kernel dirty-cache writes destined for removable USB block
 * devices and shows a real-time top-bar indicator until the flush is done.
 *
 * Architecture:
 *  • UDisks2 D-Bus → discover which block devices are removable + mounted
 *  • /sys/block/<dev>/stat → per-device write sectors & I/O request counts
 *  • Delta tracking + threshold heuristics → ignore metadata writes,
 *    only trigger on real file copy/move operations
 *  • GLib.timeout_add_seconds → 2-second polling loop
 *  • PanelMenu.Button → hidden when idle, visible when writing
 *
 * GNOME 45 / 46 + (ESM – no legacy imports.gi)
 *
 * Fork addition: reads Filesystem.MountPoints and watches the mount with
 * Gio.FileMonitor to learn the target file's (often preallocated) final
 * size, so we can show a real percentage/progress bar instead of just
 * "N MB written". Falls back to the original text-only display when no
 * target size can be determined.
 */

import GLib     from 'gi://GLib';
import Gio      from 'gi://Gio';
import St       from 'gi://St';
import Clutter  from 'gi://Clutter';

import { Extension }   from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main       from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu  from 'resource:///org/gnome/shell/ui/panelMenu.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_SECONDS = 2;
const NOTIFY_COOLDOWN_MS    = 10_000; // min gap between "safe to eject" toasts

// ── Write-detection thresholds ───────────────────────────────────────────────
//
// Two-phase detection strategy:
//
//   Phase 1 — TRIGGER:  Strict thresholds to START a write burst.
//     Only large, sustained I/O can trigger the indicator.  This filters out
//     small metadata writes (journal commits, inode updates, dir entries).
//
//   Phase 2 — SUSTAIN:  Once triggered, ANY device write activity (even small)
//     keeps the indicator alive.  This prevents the indicator from flickering
//     off between kernel writeback bursts during an active copy.
//
//   DONE:  Only when the device is truly idle (zero sector change AND zero
//     in-flight I/O) for a sustained period do we declare the copy finished.

// Phase 1 thresholds (must pass BOTH to trigger)
const MIN_WRITE_RATE_BYTES  = 64 * 1024;  // 64 KB per tick (~32 KB/s @2s poll)
const MIN_AVG_IO_SIZE_BYTES = 16 * 1024;  // 16 KB avg request size

// How many consecutive "truly idle" ticks (no sector change, no in-flight)
// before declaring the write finished.  Linux writeback is bursty, so we need
// a generous window to avoid premature "done" between flush rounds.
// 5 ticks × 2 seconds = 10 second grace period.
const IDLE_TICKS_BEFORE_DONE = 5;

// Fork addition: ignore files smaller than this when looking for the
// "target" transfer file, to avoid locking onto thumbnails/lockfiles/etc.
const MIN_TARGET_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// Fork addition: fixed width (px) of the graphical progress bar in the panel.
const BAR_WIDTH_PX = 80;

// UDisks2 well-known names
const UDISKS2_BUS_NAME  = 'org.freedesktop.UDisks2';
const UDISKS2_OBJ_PATH  = '/org/freedesktop/UDisks2';
const DBUS_OBJMAN_IFACE = 'org.freedesktop.DBus.ObjectManager';
const UDISKS2_BLOCK     = 'org.freedesktop.UDisks2.Block';
const UDISKS2_DRIVE     = 'org.freedesktop.UDisks2.Drive';
const UDISKS2_FS        = 'org.freedesktop.UDisks2.Filesystem';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Promisify Gio.File.load_contents_async for async/await usage
Gio._promisify(Gio.File.prototype, 'load_contents_async');

/**
 * Read a text file asynchronously via Gio.
 * Returns null on any error so callers can handle gracefully.
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function readFileAsync(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [contents] = await file.load_contents_async(null);
        return new TextDecoder().decode(contents);
    } catch (_) {
        return null;
    }
}

/**
 * Strip the partition suffix from a device name to get the parent disk.
 * UDisks2 reports partition names (e.g. "sda1") but /sys/block/ only
 * contains whole-disk entries (e.g. "sda").
 *
 * Handles:
 *   "sda1"       → "sda"
 *   "nvme0n1p1"  → "nvme0n1"
 *   "sda"        → "sda"   (already a whole disk)
 *
 * @param {string} devName
 * @returns {string}
 */
function toParentDisk(devName) {
    // NVMe: nvme0n1p1 → nvme0n1  (strip the trailing pN)
    const nvmeMatch = devName.match(/^(nvme\d+n\d+)p\d+$/);
    if (nvmeMatch) return nvmeMatch[1];

    // SCSI / USB: sda1 → sda, sdb2 → sdb  (strip trailing digits)
    const sdMatch = devName.match(/^(sd[a-z]+)\d+$/);
    if (sdMatch) return sdMatch[1];

    // mmcblk: mmcblk0p1 → mmcblk0
    const mmcMatch = devName.match(/^(mmcblk\d+)p\d+$/);
    if (mmcMatch) return mmcMatch[1];

    return devName; // already a whole-disk name
}

/**
 * Parse /sys/block/<dev>/stat and return write-related counters.
 * Stat fields (0-indexed): https://www.kernel.org/doc/Documentation/block/stat.txt
 *   4 — writes completed
 *   5 — writes merged
 *   6 — sectors written  (each sector = 512 bytes)
 *   8 — I/Os currently in progress
 *
 * Automatically resolves partition names (e.g. "sda1") to the parent disk
 * ("sda") since /sys/block/ only has whole-disk entries.
 *
 * @param {string} devName  e.g. "sdb1" or "sdb"
 * @returns {Promise<{ writesCompleted: number, sectorsWritten: number, inFlight: number }>}
 */
async function getBlockWriteStats(devName) {
    const disk = toParentDisk(devName);
    const text = await readFileAsync(`/sys/block/${disk}/stat`);
    if (!text) return { writesCompleted: 0, sectorsWritten: 0, inFlight: 0 };
    const f = text.trim().split(/\s+/);
    return {
        writesCompleted : parseInt(f[4], 10) || 0,
        sectorsWritten  : parseInt(f[6], 10) || 0,
        inFlight        : parseInt(f[8], 10) || 0,
    };
}

/**
 * Strip the '/dev/' prefix from a device path string coming from UDisks2
 * (which encodes them as byte arrays in GLib variants).
 * @param {GLib.Variant} byteArrayVariant
 * @returns {string}  e.g. "sdb"
 */
function devicePathToName(byteArrayVariant) {
    try {
        // UDisks2 Device property is 'ay' (byte array).
        // deep_unpack() returns a Uint8Array — decode it directly.
        const bytes = byteArrayVariant.deep_unpack(); // Uint8Array
        // Strip trailing null terminator then decode as UTF-8
        let end = bytes.length;
        while (end > 0 && bytes[end - 1] === 0) end--;
        const str = new TextDecoder().decode(bytes.subarray(0, end));
        return str.replace('/dev/', '');
    } catch (_) {
        return '';
    }
}

// Fork addition: Filesystem.MountPoints is 'aay' (array of byte arrays).
// Returns the first decoded mount point, or null if not mounted.
function firstMountPoint(mountPointsVariant) {
    try {
        const arr = mountPointsVariant.deep_unpack();
        if (!arr || arr.length === 0) return null;
        const first = arr[0];
        // GJS may hand back elements as raw Uint8Array or as GVariant
        // depending on version — handle both.
        if (first instanceof Uint8Array) {
            let end = first.length;
            while (end > 0 && first[end - 1] === 0) end--;
            return new TextDecoder().decode(first.subarray(0, end));
        }
        const bytes = first.deep_unpack();
        let end = bytes.length;
        while (end > 0 && bytes[end - 1] === 0) end--;
        return new TextDecoder().decode(bytes.subarray(0, end));
    } catch (_) {
        return null;
    }
}

// ─── Main Extension Class ─────────────────────────────────────────────────────

export default class TrueUsbProgressExtension extends Extension {

    // ── Lifecycle ──────────────────────────────────────────────────────────

    enable() {
        this._removableDevices = new Map();   // Map<devName, { label }>
        this._lastNotifyTime   = 0;
        this._pollSourceId     = null;
        this._udisksSignalIds  = [];
        this._dbusConnection   = null;

        // Per-device I/O state + write-detection state machine
        // Map<devName, {
        //   prevWrites, prevSectors,      — cumulative counters from last tick
        //   totalBytesThisBurst,          — bytes written in current burst
        //   deltaBytesThisTick,           — bytes written this tick (for speed)
        //   wasWriting,                   — is this device in an active burst?
        //   idleTicks,                    — consecutive idle ticks
        //   lastRateMBs,                  — last known write speed string
        // }>
        this._devStats         = new Map();

        // Fork addition: one Gio.FileMonitor per watched mount point, used
        // to detect the transfer's target file and its final size.
        this._fileMonitors      = new Map(); // Map<devName, Gio.FileMonitor>
        this._fileMonitorSigIds = new Map(); // Map<devName, signal id>

        this._buildIndicator();
        this._connectUDisks2();
        this._startPolling();
    }

    disable() {
        this._stopPolling();
        this._disconnectUDisks2();
        this._clearAllFileMonitors();
        this._destroyIndicator();

        this._removableDevices = null;
        this._devStats         = null;
    }

    // ── Indicator (PanelMenu.Button) ───────────────────────────────────────

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._indicator.reactive = true;

        // Container: icon + label, horizontal
        const box = new St.BoxLayout({
            style_class : 'panel-status-menu-box',
            vertical    : false,
        });

        // Drive / USB icon
        this._icon = new St.Icon({
            icon_name   : 'drive-removable-media-usb-symbolic',
            style_class : 'system-status-icon',
        });

        // Progress text label
        this._label = new St.Label({
            text        : '',
            y_align     : Clutter.ActorAlign.CENTER,
            style       : 'margin-left: 4px; font-weight: bold;',
        });

        // Fork addition: graphical progress bar, shown only when at least
        // one active device has a known target size.
        this._barBg = new St.Widget({
            style: `width: ${BAR_WIDTH_PX}px; height: 8px; border-radius: 4px;
                    background-color: rgba(255,255,255,0.15); margin-left: 6px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._barFill = new St.Widget({
            style: `width: 0px; height: 8px; border-radius: 4px;
                    background-color: #3584e4;`,
        });
        this._barBg.add_child(this._barFill);
        this._barBg.hide();

        box.add_child(this._icon);
        box.add_child(this._barBg);
        box.add_child(this._label);
        this._indicator.add_child(box);

        // Start hidden; shown only when USB writes are active
        this._indicator.hide();

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    _destroyIndicator() {
        this._icon?.destroy();
        this._icon = null;

        this._barFill = null; // child of _barBg, destroyed with it
        this._barBg?.destroy();
        this._barBg = null;

        this._label?.destroy();
        this._label = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    // ── UDisks2 D-Bus integration ──────────────────────────────────────────

    _connectUDisks2() {
        try {
            this._dbusConnection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        } catch (e) {
            logError(e, '[TrueUsbProgress] Could not get system D-Bus connection');
            return;
        }

        // Initial enumeration of existing objects
        this._enumerateUDisks2Objects();

        // Watch for objects added / removed while extension is active
        const addedId = this._dbusConnection.signal_subscribe(
            UDISKS2_BUS_NAME,
            DBUS_OBJMAN_IFACE,
            'InterfacesAdded',
            UDISKS2_OBJ_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onInterfacesAdded.bind(this),
        );
        const removedId = this._dbusConnection.signal_subscribe(
            UDISKS2_BUS_NAME,
            DBUS_OBJMAN_IFACE,
            'InterfacesRemoved',
            UDISKS2_OBJ_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onInterfacesRemoved.bind(this),
        );

        this._udisksSignalIds.push(addedId, removedId);
    }

    _disconnectUDisks2() {
        if (this._dbusConnection) {
            for (const id of this._udisksSignalIds)
                this._dbusConnection.signal_unsubscribe(id);
        }
        this._udisksSignalIds  = [];
        this._dbusConnection   = null;
    }

    /**
     * Call GetManagedObjects on UDisks2 to enumerate all current block devices
     * and find which ones are removable USB drives that are mounted.
     */
    _enumerateUDisks2Objects() {
        if (!this._dbusConnection) return;

        this._dbusConnection.call(
            UDISKS2_BUS_NAME,
            UDISKS2_OBJ_PATH,
            DBUS_OBJMAN_IFACE,
            'GetManagedObjects',
            null,
            new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE,
            5000,
            null,
            (conn, res) => {
                try {
                    const reply  = conn.call_finish(res);
                    const [objects] = reply.deep_unpack();
                    this._processUDisks2Objects(objects);
                } catch (e) {
                    logError(e, '[TrueUsbProgress] GetManagedObjects failed');
                }
            },
        );
    }

    /**
     * Walk the UDisks2 object tree.  For each block device we check:
     *   1. Does it have a Block interface with a Drive property?
     *   2. Is that Drive removable with ConnectionBus == "usb"?
     *   3. Does it have a Filesystem interface (i.e. is it mounted)?
     * If all true → add to _removableDevices with a human-readable label.
     *
     * Label priority:  filesystem label (IdLabel) → drive model → dev name.
     *
     * Fork addition: also reads Filesystem.MountPoints and reconciles the
     * per-device Gio.FileMonitor set accordingly.
     */
    _processUDisks2Objects(objects) {
        // Build a drive-path → { isUsb, model } map first
        const driveInfo = {};
        for (const [objPath, ifaces] of Object.entries(objects)) {
            if (!objPath.startsWith('/org/freedesktop/UDisks2/drives/')) continue;
            const driveIface = ifaces[UDISKS2_DRIVE];
            if (!driveIface) continue;
            const removable      = driveIface['Removable']?.deep_unpack()      ?? false;
            const connectionBus  = driveIface['ConnectionBus']?.deep_unpack()  ?? '';
            const model          = driveIface['Model']?.deep_unpack()          ?? '';
            driveInfo[objPath]   = {
                isUsb : removable && connectionBus === 'usb',
                model : model.trim(),
            };
        }

        // Now check block devices
        const newDevices = new Map();
        for (const [, ifaces] of Object.entries(objects)) {
            const blockIface = ifaces[UDISKS2_BLOCK];
            if (!blockIface) continue;

            const drivePath = blockIface['Drive']?.deep_unpack() ?? '/';
            const info      = driveInfo[drivePath];
            if (!info?.isUsb) continue;

            // Must have a Filesystem interface (partitions without mounts are ignored)
            const fsIface = ifaces[UDISKS2_FS];
            if (!fsIface) continue;

            const devVariant = blockIface['Device'];
            if (!devVariant) continue;
            const devName = devicePathToName(devVariant);
            if (!devName) continue;

            // Pick the best human-readable label
            const fsLabel = blockIface['IdLabel']?.deep_unpack()?.trim() ?? '';
            const label   = fsLabel || info.model || devName;

            const mountPoint = fsIface['MountPoints']
                ? firstMountPoint(fsIface['MountPoints'])
                : null;

            // Keep any in-progress target info across re-enumerations, so an
            // unrelated InterfacesAdded/Removed event (e.g. another drive
            // plugged in) doesn't reset a transfer already being tracked.
            const prev = this._removableDevices.get(devName);

            newDevices.set(devName, {
                label,
                mountPoint,
                targetFile : prev?.targetFile ?? null,
                targetSize : prev?.targetSize ?? 0,
            });

            log(`[TrueUsbProgress] Tracking USB device: /dev/${devName} ("${label}") mount=${mountPoint}`);
        }

        this._removableDevices = newDevices;
        this._reconcileFileMonitors();
    }

    /** UDisks2 InterfacesAdded — re-enumerate so we pick up new mounts */
    _onInterfacesAdded(_conn, _sender, _objPath, _iface, _signal, _params) {
        this._enumerateUDisks2Objects();
    }

    /** UDisks2 InterfacesRemoved — re-enumerate so we drop unmounted devices */
    _onInterfacesRemoved(_conn, _sender, _objPath, _iface, _signal, _params) {
        this._enumerateUDisks2Objects();
    }

    // ── Fork addition: file monitoring for target-size detection ────────────

    // Keep exactly one Gio.FileMonitor per currently-tracked device that has
    // a known mount point, and none for devices no longer present.
    _reconcileFileMonitors() {
        if (!this._removableDevices) return;

        for (const devName of [...this._fileMonitors.keys()]) {
            if (!this._removableDevices.has(devName))
                this._removeFileMonitor(devName);
        }

        for (const [devName, info] of this._removableDevices) {
            if (!info.mountPoint) continue;
            if (this._fileMonitors.has(devName)) continue;
            this._addFileMonitor(devName, info.mountPoint);
        }
    }

    _addFileMonitor(devName, mountPoint) {
        try {
            const dir = Gio.File.new_for_path(mountPoint);
            const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            const sigId = monitor.connect('changed', (_mon, file, _other, eventType) => {
                this._onFileEvent(devName, file, eventType);
            });
            this._fileMonitors.set(devName, monitor);
            this._fileMonitorSigIds.set(devName, sigId);
        } catch (e) {
            logError(e, `[TrueUsbProgress] Could not watch ${mountPoint}`);
        }
    }

    _removeFileMonitor(devName) {
        const monitor = this._fileMonitors.get(devName);
        if (monitor) {
            const sigId = this._fileMonitorSigIds.get(devName);
            if (sigId) monitor.disconnect(sigId);
            monitor.cancel();
        }
        this._fileMonitors.delete(devName);
        this._fileMonitorSigIds.delete(devName);
    }

    _clearAllFileMonitors() {
        for (const devName of [...this._fileMonitors.keys()])
            this._removeFileMonitor(devName);
    }

    // When a large-enough new file appears on a watched mount, treat it as
    // the transfer's target and read its (often preallocated) final size.
    _onFileEvent(devName, file, eventType) {
        if (eventType !== Gio.FileMonitorEvent.CREATED &&
            eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT)
            return;

        if (!this._removableDevices?.has(devName)) return;

        try {
            const info = file.query_info('standard::size,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_file_type() !== Gio.FileType.REGULAR) return;

            const size = info.get_size();
            if (size < MIN_TARGET_FILE_SIZE_BYTES) return;

            const devInfo = this._removableDevices.get(devName);
            devInfo.targetFile = file.get_path();
            devInfo.targetSize = size;
        } catch (_) {
            // file may have vanished/renamed between the event and the query
        }
    }

    // ── Polling ────────────────────────────────────────────────────────────

    _startPolling() {
        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _stopPolling() {
        if (this._pollSourceId !== null) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = null;
        }
    }

    /**
     * Called every POLL_INTERVAL_SECONDS.
     *
     * Each USB device runs its own independent two-phase state machine:
     *
     *   TRIGGER (Phase 1) — strict thresholds on write rate AND average I/O
     *     size.  Only large sequential writes (file copies) can start a burst.
     *     Small metadata writes are ignored.
     *
     *   SUSTAIN (Phase 2) — once triggered, ANY device write activity
     *     (even small) keeps the device's indicator alive.  This prevents
     *     flickering between writeback bursts during an active copy.
     *
     *   DONE — a device's burst ends only after it is truly idle
     *     (zero sector changes AND zero in-flight I/O) for
     *     IDLE_TICKS_BEFORE_DONE consecutive ticks.  A notification fires
     *     naming only that specific device.
     */
    async _tick() {
        if (!this._indicator) return;                  // extension disabled mid-tick

        if (this._removableDevices.size === 0) {
            this._indicator.hide();
            return;
        }

        // Names of devices that just finished their burst this tick
        const justFinished = [];

        // ── 1. Per-device delta analysis + state machine ──────────────────
        for (const [dev, devInfo] of this._removableDevices) {
            const stats = await getBlockWriteStats(dev);

            // Guard: extension may have been disabled during the async read
            if (!this._indicator) return;

            let st = this._devStats.get(dev);

            if (!st) {
                // First time seeing this device — store baseline
                st = {
                    prevWrites         : stats.writesCompleted,
                    prevSectors        : stats.sectorsWritten,
                    totalBytesThisBurst: 0,
                    deltaBytesThisTick : 0,
                    wasWriting         : false,
                    idleTicks          : 0,
                    lastRateMBs        : '0.0',
                };
                this._devStats.set(dev, st);
                continue;
            }

            const deltaWrites  = stats.writesCompleted - st.prevWrites;
            const deltaSectors = stats.sectorsWritten  - st.prevSectors;
            const deltaBytes   = deltaSectors * 512;
            const inFlight     = stats.inFlight > 0;

            // Update cumulative counters
            st.prevWrites  = stats.writesCompleted;
            st.prevSectors = stats.sectorsWritten;

            // Classify activity for this device
            const hasActivity   = deltaWrites > 0 && deltaSectors > 0;
            const avgIOSize     = hasActivity ? deltaBytes / deltaWrites : 0;
            const isLargeWrite  = hasActivity &&
                                  deltaBytes >= MIN_WRITE_RATE_BYTES &&
                                  avgIOSize  >= MIN_AVG_IO_SIZE_BYTES;

            // Track this tick's delta for speed display
            st.deltaBytesThisTick = hasActivity ? deltaBytes : 0;

            if (hasActivity) {
                st.totalBytesThisBurst += deltaBytes;
            }

            // ── Per-device state machine ───────────────────────────────────
            if (!st.wasWriting) {
                // Phase 1: only large writes can start a burst
                if (isLargeWrite) {
                    st.wasWriting = true;
                    st.idleTicks  = 0;
                }
            } else {
                // Phase 2: any activity or in-flight keeps it alive
                if (hasActivity || inFlight) {
                    st.idleTicks = 0;
                } else {
                    st.idleTicks++;
                    if (st.idleTicks >= IDLE_TICKS_BEFORE_DONE) {
                        // This device is DONE
                        st.wasWriting          = false;
                        st.idleTicks           = 0;
                        st.totalBytesThisBurst = 0;
                        st.lastRateMBs         = '0.0';
                        // Fork addition: clear target too, so the next
                        // detected file starts a fresh transfer.
                        devInfo.targetFile = null;
                        devInfo.targetSize = 0;
                        justFinished.push(devInfo.label);
                    }
                }
            }

            // Update speed string when we have fresh data
            if (st.deltaBytesThisTick > 0) {
                st.lastRateMBs = (st.deltaBytesThisTick / (1024 * 1024) / POLL_INTERVAL_SECONDS).toFixed(1);
            }
        }

        // ── 2. Fire notifications for any devices that just finished ──────
        for (const name of justFinished) {
            this._notifySyncComplete(name);
        }

        // ── 3. Build indicator from all devices currently writing ─────────
        const activeDevices = [];
        for (const [dev, devInfo] of this._removableDevices) {
            const st = this._devStats.get(dev);
            if (!st?.wasWriting) continue;
            activeDevices.push({ dev, devInfo, st });
        }

        if (activeDevices.length > 0) {
            // Fork addition: include a percentage when target size is known,
            // otherwise fall back to the original "MB (rate)" text.
            const parts = activeDevices.map(({ devInfo, st }) => {
                const mb = (st.totalBytesThisBurst / (1024 * 1024)).toFixed(1);
                const rateSuffix = st.deltaBytesThisTick > 0 ? ` (${st.lastRateMBs} MB/s)` : '';

                if (devInfo.targetSize > 0) {
                    const fraction = Math.max(0, Math.min(1, st.totalBytesThisBurst / devInfo.targetSize));
                    const pct = Math.round(fraction * 100);
                    const totalMb = (devInfo.targetSize / (1024 * 1024)).toFixed(0);
                    return { text: `${devInfo.label}: ${pct}% · ${mb}/${totalMb} MB${rateSuffix}`, fraction };
                }
                return { text: `${devInfo.label}: ${mb} MB${rateSuffix}`, fraction: null };
            });

            this._label.set_text(parts.map(p => p.text).join(' · '));

            // Fork addition: graphical bar reflects the highest-known
            // fraction among active devices; hidden if none is known.
            const known = parts.filter(p => p.fraction !== null);
            if (known.length > 0) {
                const best = known.reduce((a, b) => (b.fraction > a.fraction ? b : a));
                this._barFill.set_style(
                    `width: ${Math.round(BAR_WIDTH_PX * best.fraction)}px; height: 8px;
                     border-radius: 4px; background-color: #3584e4;`);
                this._barBg.show();
            } else {
                this._barBg.hide();
            }

            this._indicator.show();
        } else {
            this._barBg.hide();
            this._indicator.hide();
        }
    }

    // ── Notification ───────────────────────────────────────────────────────

    /**
     * Notify the user that a specific USB drive has finished syncing.
     * @param {string} driveName  Human-readable label of the drive
     */
    _notifySyncComplete(driveName) {
        const now = GLib.get_monotonic_time() / 1000; // µs → ms
        if (now - this._lastNotifyTime < NOTIFY_COOLDOWN_MS) return;
        this._lastNotifyTime = now;

        Main.notify(
            'USB Sync Complete',
            `Write cache flushed — safe to eject ${driveName}.`,
        );
    }
}
