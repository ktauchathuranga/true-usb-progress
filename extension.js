/**
 * True USB Write Progress — GNOME Shell Extension
 * UUID : true-usb-progress@ktauchathuranga.github.io
 *
 * Monitors kernel dirty-cache writes destined for removable USB block
 * devices and shows a real-time top-bar indicator until the flush is done.
 *
 * Architecture:
 *  • UDisks2 D-Bus → discover which block devices are removable + mounted
 *  • /proc/meminfo  → system-wide Dirty + Writeback kB
 *  • /sys/block/<dev>/stat → per-device in-flight I/O sectors
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
const DIRTY_THRESHOLD_KB    = 512;   // ignore noise below this
const NOTIFY_COOLDOWN_MS    = 10_000; // min gap between "safe to eject" toasts

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
 * Parse /proc/meminfo and return { dirty_kb, writeback_kb }.
 * @returns {{ dirty_kb: number, writeback_kb: number }}
 */
function parseProcMeminfo() {
    const text = readFileSync('/proc/meminfo');
    if (!text) return { dirty_kb: 0, writeback_kb: 0 };

    let dirty_kb    = 0;
    let writeback_kb = 0;

    for (const line of text.split('\n')) {
        if (line.startsWith('Dirty:'))
            dirty_kb    = parseInt(line.split(/\s+/)[1], 10) || 0;
        else if (line.startsWith('Writeback:'))
            writeback_kb = parseInt(line.split(/\s+/)[1], 10) || 0;
    }
    return { dirty_kb, writeback_kb };
}

/**
 * Parse /sys/block/<dev>/stat and return the number of I/O operations
 * currently in-flight (field 9, 0-indexed).
 * Stat fields: https://www.kernel.org/doc/Documentation/block/stat.txt
 * @param {string} devName  e.g. "sdb"
 * @returns {number}
 */
function getBlockInFlight(devName) {
    const text = readFileSync(`/sys/block/${devName}/stat`);
    if (!text) return 0;
    const fields = text.trim().split(/\s+/);
    // field index 8 = ios_in_progress (1-based column 9)
    return parseInt(fields[8], 10) || 0;
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

        this._buildIndicator();
        this._connectUDisks2();
        this._startPolling();
    }

    disable() {
        this._stopPolling();
        this._disconnectUDisks2();
        this._destroyIndicator();

        this._removableDevices = null;
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
     * Combines system dirty-cache data with per-device in-flight I/O to decide
     * whether USB writes are currently active.
     */
    _tick() {
        if (!this._indicator) return;                  // extension disabled mid-tick

        // ── 1. System dirty cache ──────────────────────────────────────────
        const { dirty_kb, writeback_kb } = parseProcMeminfo();
        const totalDirty_kb = dirty_kb + writeback_kb;

        // ── 2. Per-device in-flight I/O ────────────────────────────────────
        let anyInFlight = false;
        for (const dev of this._removableDevices) {
            if (getBlockInFlight(dev) > 0) {
                anyInFlight = true;
                break;
            }
        }

        // ── 3. Decide write state ──────────────────────────────────────────
        // We consider a write "active" if:
        //   • there is non-trivial dirty data in the page cache  AND
        //   • at least one tracked removable device has in-flight I/O
        //
        // We stay in "writing" state as long as dirty cache remains above the
        // threshold OR in-flight I/O is still happening (handles the small
        // window where dirty_kb already drained but I/O hasn't completed).
        const hasRemovable = this._removableDevices.size > 0;
        const isWriting    = hasRemovable && (
            (totalDirty_kb > DIRTY_THRESHOLD_KB) || anyInFlight
        );

        // ── 4. Update indicator ────────────────────────────────────────────
        if (isWriting) {
            const mb = (totalDirty_kb / 1024).toFixed(1);
            this._label.set_text(`Writing: ${mb} MB`);
            this._indicator.show();
            this._wasWriting = true;
        } else {
            this._indicator.hide();

            // Emit "safe to eject" notification once per completed write burst
            if (this._wasWriting && hasRemovable) {
                this._wasWriting = false;
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
