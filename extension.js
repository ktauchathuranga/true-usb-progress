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

// UDisks2 well-known names
const UDISKS2_BUS_NAME  = 'org.freedesktop.UDisks2';
const UDISKS2_OBJ_PATH  = '/org/freedesktop/UDisks2';
const DBUS_OBJMAN_IFACE = 'org.freedesktop.DBus.ObjectManager';
const UDISKS2_BLOCK     = 'org.freedesktop.UDisks2.Block';
const UDISKS2_DRIVE     = 'org.freedesktop.UDisks2.Drive';
const UDISKS2_FS        = 'org.freedesktop.UDisks2.Filesystem';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read a text file synchronously via GLib.
 * Returns null on any error so callers can handle gracefully.
 * @param {string} path
 * @returns {string|null}
 */
function readFileSync(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return null;
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
 * @returns {{ writesCompleted: number, sectorsWritten: number, inFlight: number }}
 */
function getBlockWriteStats(devName) {
    const disk = toParentDisk(devName);
    const text = readFileSync(`/sys/block/${disk}/stat`);
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

// ─── Main Extension Class ─────────────────────────────────────────────────────

export default class TrueUsbProgressExtension extends Extension {

    // ── Lifecycle ──────────────────────────────────────────────────────────

    enable() {
        this._removableDevices = new Set();   // set of dev names e.g. "sdb"
        this._wasWriting       = false;
        this._lastNotifyTime   = 0;
        this._pollSourceId     = null;
        this._udisksSignalIds  = [];
        this._dbusConnection   = null;

        // Per-device state for delta tracking
        // Map<devName, { prevWrites, prevSectors, totalBytesThisBurst }>
        this._devStats         = new Map();
        this._idleTicks        = 0;    // consecutive ticks with zero device activity
        this._lastRateMBs      = '0.0'; // last known write speed for display

        this._buildIndicator();
        this._connectUDisks2();
        this._startPolling();
    }

    disable() {
        this._stopPolling();
        this._disconnectUDisks2();
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

        box.add_child(this._icon);
        box.add_child(this._label);
        this._indicator.add_child(box);

        // Start hidden; shown only when USB writes are active
        this._indicator.hide();

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    _destroyIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._icon  = null;
        this._label = null;
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
     * If all true → add its device name to _removableDevices.
     */
    _processUDisks2Objects(objects) {
        // Build a drive-path → removable+usb map first
        const driveIsUsb = {};
        for (const [objPath, ifaces] of Object.entries(objects)) {
            if (!objPath.startsWith('/org/freedesktop/UDisks2/drives/')) continue;
            const driveIface = ifaces[UDISKS2_DRIVE];
            if (!driveIface) continue;
            const removable      = driveIface['Removable']?.deep_unpack()      ?? false;
            const connectionBus  = driveIface['ConnectionBus']?.deep_unpack()  ?? '';
            driveIsUsb[objPath]  = removable && connectionBus === 'usb';
        }

        // Now check block devices
        this._removableDevices.clear();
        for (const [, ifaces] of Object.entries(objects)) {
            const blockIface = ifaces[UDISKS2_BLOCK];
            if (!blockIface) continue;

            const drivePath = blockIface['Drive']?.deep_unpack() ?? '/';
            if (!driveIsUsb[drivePath]) continue;

            // Must have a Filesystem interface (partitions without mounts are ignored)
            if (!ifaces[UDISKS2_FS]) continue;

            const devVariant = blockIface['Device'];
            if (!devVariant) continue;
            const devName = devicePathToName(devVariant);
            if (devName) {
                this._removableDevices.add(devName);
                log(`[TrueUsbProgress] Tracking removable USB device: /dev/${devName}`);
            }
        }
    }

    /** UDisks2 InterfacesAdded — re-enumerate so we pick up new mounts */
    _onInterfacesAdded(_conn, _sender, _objPath, _iface, _signal, _params) {
        this._enumerateUDisks2Objects();
    }

    /** UDisks2 InterfacesRemoved — re-enumerate so we drop unmounted devices */
    _onInterfacesRemoved(_conn, _sender, _objPath, _iface, _signal, _params) {
        this._enumerateUDisks2Objects();
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
     * Two-phase write detection:
     *
     *   TRIGGER (Phase 1) — strict thresholds on write rate AND average I/O
     *     size.  Only large sequential writes (file copies) can start a burst.
     *     Small metadata writes are ignored.
     *
     *   SUSTAIN (Phase 2) — once a burst is active, ANY device write activity
     *     (even small sector changes or in-flight I/O) keeps the indicator
     *     alive.  This prevents flickering between kernel writeback rounds.
     *
     *   DONE — the indicator hides only after the device is truly idle
     *     (zero sector changes AND zero in-flight I/O) for
     *     IDLE_TICKS_BEFORE_DONE consecutive ticks.
     */
    _tick() {
        if (!this._indicator) return;                  // extension disabled mid-tick

        const hasRemovable = this._removableDevices.size > 0;
        if (!hasRemovable) {
            this._indicator.hide();
            return;
        }

        // ── 1. Per-device delta analysis ───────────────────────────────────
        let totalDeltaBytes = 0;
        let anyLargeWrite   = false;   // passes Phase 1 thresholds
        let anyActivity     = false;   // ANY write activity at all
        let anyInFlight     = false;

        for (const dev of this._removableDevices) {
            const stats = getBlockWriteStats(dev);
            const prev  = this._devStats.get(dev);

            if (stats.inFlight > 0) anyInFlight = true;

            if (!prev) {
                // First time seeing this device — store baseline, skip delta
                this._devStats.set(dev, {
                    prevWrites         : stats.writesCompleted,
                    prevSectors        : stats.sectorsWritten,
                    totalBytesThisBurst: 0,
                });
                continue;
            }

            const deltaWrites  = stats.writesCompleted - prev.prevWrites;
            const deltaSectors = stats.sectorsWritten  - prev.prevSectors;
            const deltaBytes   = deltaSectors * 512;

            // Update stored counters
            prev.prevWrites  = stats.writesCompleted;
            prev.prevSectors = stats.sectorsWritten;

            if (deltaWrites <= 0 || deltaSectors <= 0) continue;

            // Any sector change at all counts as activity
            anyActivity = true;
            prev.totalBytesThisBurst += deltaBytes;
            totalDeltaBytes          += deltaBytes;

            const avgIOSize = deltaBytes / deltaWrites;

            // Phase 1: check if this qualifies as a real file write
            if (deltaBytes >= MIN_WRITE_RATE_BYTES &&
                avgIOSize  >= MIN_AVG_IO_SIZE_BYTES) {
                anyLargeWrite = true;
            }
        }

        // ── 2. Two-phase state machine ─────────────────────────────────────
        //
        //  • NOT writing + large write detected  →  START burst
        //  • Writing + any activity or in-flight  →  SUSTAIN (reset idle timer)
        //  • Writing + no activity + no in-flight →  tick idle counter
        //  • Writing + idle counter exceeded      →  DONE

        let isWriting;

        if (!this._wasWriting) {
            // Phase 1: only large writes can start a burst
            isWriting = anyLargeWrite;
        } else {
            // Phase 2: any activity or in-flight I/O keeps us alive
            if (anyActivity || anyInFlight) {
                this._idleTicks = 0;
                isWriting = true;
            } else {
                // Device is fully idle this tick
                this._idleTicks++;
                isWriting = this._idleTicks < IDLE_TICKS_BEFORE_DONE;
            }
        }

        // ── 3. Update indicator ────────────────────────────────────────────
        if (isWriting) {
            // Sum total bytes written across all tracked devices in this burst
            let burstTotal = 0;
            for (const [, st] of this._devStats) {
                burstTotal += st.totalBytesThisBurst;
            }

            const writtenMB = (burstTotal / (1024 * 1024)).toFixed(1);

            if (totalDeltaBytes > 0) {
                // Actively writing — show speed
                this._lastRateMBs = (totalDeltaBytes / (1024 * 1024) / POLL_INTERVAL_SECONDS).toFixed(1);
                this._label.set_text(`Writing: ${writtenMB} MB (${this._lastRateMBs} MB/s)`);
            } else if (anyInFlight) {
                // Sectors stopped but I/O still completing — final sync
                this._label.set_text(`Syncing: ${writtenMB} MB written`);
            } else {
                // Brief gap between writeback bursts — keep showing total
                this._label.set_text(`Writing: ${writtenMB} MB`);
            }

            this._indicator.show();
            this._wasWriting = true;
        } else {
            this._indicator.hide();

            // Emit "safe to eject" notification once per completed write burst
            if (this._wasWriting) {
                this._wasWriting   = false;
                this._idleTicks    = 0;
                this._lastRateMBs  = '0.0';
                // Reset burst counters for next copy
                for (const [, st] of this._devStats) {
                    st.totalBytesThisBurst = 0;
                }
                this._notifySyncComplete();
            }
        }
    }

    // ── Notification ───────────────────────────────────────────────────────

    _notifySyncComplete() {
        const now = GLib.get_monotonic_time() / 1000; // µs → ms
        if (now - this._lastNotifyTime < NOTIFY_COOLDOWN_MS) return;
        this._lastNotifyTime = now;

        Main.notify(
            'USB Sync Complete',
            'Write cache flushed — safe to eject your USB drive.',
        );
    }
}
