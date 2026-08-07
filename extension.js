/**
 * True USB Write Progress — GNOME Shell Extension (merged fork)
 * UUID : true-usb-progress@ktauchathuranga.github.io
 *
 * Base: UDisks2 D-Bus discovery + /sys/block stat polling + two-phase
 * write-detection state machine (original project).
 *
 * Added in this fork:
 *   • Reads UDisks2 Filesystem.MountPoints to know WHERE each device is
 *     mounted.
 *   • Watches that mount point with Gio.FileMonitor for newly created
 *     files above a size threshold, to learn the TARGET size of the
 *     transfer (works because many copy tools/filesystems preallocate
 *     the final file size immediately).
 *   • When a target size is known, computes a real percentage and draws
 *     an actual progress bar in the panel, instead of only "N MB (rate)".
 *   • Falls back gracefully to the original text-only behaviour when no
 *     target size could be determined (e.g. file in a subfolder, or a
 *     filesystem/tool that doesn't preallocate).
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

// ── Write-detection thresholds (unchanged from original) ────────────────────
const MIN_WRITE_RATE_BYTES  = 64 * 1024;  // 64 KB per tick (~32 KB/s @2s poll)
const MIN_AVG_IO_SIZE_BYTES = 16 * 1024;  // 16 KB avg request size
const IDLE_TICKS_BEFORE_DONE = 5;         // 5 * 2s = 10s idle before DONE

// ── Target-size detection (new) ──────────────────────────────────────────────
// Ignore small files (thumbnails, lockfiles, .Trash-*, journal entries, ecc.)
// so we don't lock onto the wrong file as "the transfer".
const MIN_TARGET_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// Larghezza fissa della barra grafica nel panel, in pixel.
const BAR_WIDTH_PX = 80;

// UDisks2 well-known names
const UDISKS2_BUS_NAME  = 'org.freedesktop.UDisks2';
const UDISKS2_OBJ_PATH  = '/org/freedesktop/UDisks2';
const DBUS_OBJMAN_IFACE = 'org.freedesktop.DBus.ObjectManager';
const UDISKS2_BLOCK     = 'org.freedesktop.UDisks2.Block';
const UDISKS2_DRIVE     = 'org.freedesktop.UDisks2.Drive';
const UDISKS2_FS        = 'org.freedesktop.UDisks2.Filesystem';

// ─── Helpers ──────────────────────────────────────────────────────────────────

Gio._promisify(Gio.File.prototype, 'load_contents_async');

async function readFileAsync(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [contents] = await file.load_contents_async(null);
        return new TextDecoder().decode(contents);
    } catch (_) {
        return null;
    }
}

function toParentDisk(devName) {
    const nvmeMatch = devName.match(/^(nvme\d+n\d+)p\d+$/);
    if (nvmeMatch) return nvmeMatch[1];

    const sdMatch = devName.match(/^(sd[a-z]+)\d+$/);
    if (sdMatch) return sdMatch[1];

    const mmcMatch = devName.match(/^(mmcblk\d+)p\d+$/);
    if (mmcMatch) return mmcMatch[1];

    return devName;
}

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
 * Decodifica un singolo byte-array GVariant ('ay') null-terminated in
 * stringa UTF-8. Usato sia per il nome device (Block.Device) sia per i
 * mount point (Filesystem.MountPoints, che è 'aay' — array di questi).
 */
function decodeByteArrayVariant(byteArrayVariant) {
    try {
        const bytes = byteArrayVariant.deep_unpack(); // Uint8Array
        let end = bytes.length;
        while (end > 0 && bytes[end - 1] === 0) end--;
        return new TextDecoder().decode(bytes.subarray(0, end));
    } catch (_) {
        return '';
    }
}

function devicePathToName(byteArrayVariant) {
    const str = decodeByteArrayVariant(byteArrayVariant);
    return str.replace('/dev/', '');
}

/**
 * Filesystem.MountPoints è un array di byte-array ('aay'). Restituisce il
 * primo mount point decodificato, o null se il device non è montato.
 */
function firstMountPoint(mountPointsVariant) {
    try {
        const arr = mountPointsVariant.deep_unpack(); // array of GVariant('ay') OR Uint8Array[]
        if (!arr || arr.length === 0) return null;
        const first = arr[0];
        // A seconda della versione di GJS, gli elementi possono arrivare già
        // come Uint8Array o come GVariant: gestiamo entrambi i casi.
        if (first instanceof Uint8Array) {
            let end = first.length;
            while (end > 0 && first[end - 1] === 0) end--;
            return new TextDecoder().decode(first.subarray(0, end));
        }
        return decodeByteArrayVariant(first);
    } catch (_) {
        return null;
    }
}

// ─── Main Extension Class ─────────────────────────────────────────────────────

export default class TrueUsbProgressExtension extends Extension {

    // ── Lifecycle ──────────────────────────────────────────────────────────

    enable() {
        // Map<devName, { label, mountPoint, targetFile, targetSize }>
        this._removableDevices = new Map();
        this._lastNotifyTime   = 0;
        this._pollSourceId     = null;
        this._udisksSignalIds  = [];
        this._dbusConnection   = null;

        // Map<devName, Gio.FileMonitor> — un monitor per ogni mount point osservato
        this._fileMonitors     = new Map();
        // Map<devName, number> — id del signal handler 'changed' per il cleanup
        this._fileMonitorSigIds = new Map();

        // Map<devName, { prevWrites, prevSectors, totalBytesThisBurst,
        //                deltaBytesThisTick, wasWriting, idleTicks, lastRateMBs }>
        this._devStats         = new Map();

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

        const box = new St.BoxLayout({
            style_class : 'panel-status-menu-box',
            vertical    : false,
        });

        this._icon = new St.Icon({
            icon_name   : 'drive-removable-media-usb-symbolic',
            style_class : 'system-status-icon',
        });

        this._label = new St.Label({
            text        : '',
            y_align     : Clutter.ActorAlign.CENTER,
            style       : 'margin-left: 4px; font-weight: bold;',
        });

        // Barra grafica: sfondo fisso + riempimento dinamico. Visibile solo
        // quando conosciamo la target size di ALMENO un device attivo.
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

        this._indicator.hide();

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    _destroyIndicator() {
        this._icon?.destroy();
        this._icon = null;

        this._barFill = null; // figlio di _barBg, distrutto insieme a lui
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

        this._enumerateUDisks2Objects();

        const addedId = this._dbusConnection.signal_subscribe(
            UDISKS2_BUS_NAME, DBUS_OBJMAN_IFACE, 'InterfacesAdded',
            UDISKS2_OBJ_PATH, null, Gio.DBusSignalFlags.NONE,
            this._onInterfacesAdded.bind(this),
        );
        const removedId = this._dbusConnection.signal_subscribe(
            UDISKS2_BUS_NAME, DBUS_OBJMAN_IFACE, 'InterfacesRemoved',
            UDISKS2_OBJ_PATH, null, Gio.DBusSignalFlags.NONE,
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

    _enumerateUDisks2Objects() {
        if (!this._dbusConnection) return;

        this._dbusConnection.call(
            UDISKS2_BUS_NAME, UDISKS2_OBJ_PATH, DBUS_OBJMAN_IFACE,
            'GetManagedObjects', null,
            new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE, 5000, null,
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
     * Come l'originale, ma in più estrae Filesystem.MountPoints per sapere
     * dove osservare i file, e riconcilia i Gio.FileMonitor di conseguenza.
     */
    _processUDisks2Objects(objects) {
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

        const newDevices = new Map();
        for (const [, ifaces] of Object.entries(objects)) {
            const blockIface = ifaces[UDISKS2_BLOCK];
            if (!blockIface) continue;

            const drivePath = blockIface['Drive']?.deep_unpack() ?? '/';
            const info      = driveInfo[drivePath];
            if (!info?.isUsb) continue;

            const fsIface = ifaces[UDISKS2_FS];
            if (!fsIface) continue; // non montato

            const devVariant = blockIface['Device'];
            if (!devVariant) continue;
            const devName = devicePathToName(devVariant);
            if (!devName) continue;

            const fsLabel = blockIface['IdLabel']?.deep_unpack()?.trim() ?? '';
            const label   = fsLabel || info.model || devName;

            const mountPoint = fsIface['MountPoints']
                ? firstMountPoint(fsIface['MountPoints'])
                : null;

            // Preserva target file/size se il device era già tracciato
            // (evita di perdere il progresso mid-transfer per un semplice
            // re-enumerate innescato da un evento InterfacesAdded/Removed
            // non correlato, es. un'altra chiavetta collegata nel frattempo).
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

    // ── File monitoring per target-size detection (new) ─────────────────────

    /**
     * Crea/rimuove i Gio.FileMonitor in modo che ci sia esattamente un
     * monitor attivo per ogni device attualmente tracciato con un mount
     * point noto, e nessuno per i device non più presenti.
     */
    _reconcileFileMonitors() {
        if (!this._removableDevices) return;

        // Rimuovi monitor per device non più presenti
        for (const devName of [...this._fileMonitors.keys()]) {
            if (!this._removableDevices.has(devName))
                this._removeFileMonitor(devName);
        }

        // Aggiungi monitor per device nuovi con mount point noto
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

    /**
     * Quando appare un file nuovo abbastanza grande nella cartella montata,
     * lo trattiamo come il file "target" del trasferimento in corso e ne
     * leggiamo la dimensione (spesso già preallocata al valore finale).
     */
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
            // il file potrebbe essere sparito/rinominato tra evento e query
        }
    }

    // ── Polling ────────────────────────────────────────────────────────────

    _startPolling() {
        this._pollSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS,
            () => { this._tick(); return GLib.SOURCE_CONTINUE; },
        );
    }

    _stopPolling() {
        if (this._pollSourceId !== null) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = null;
        }
    }

    async _tick() {
        if (!this._indicator) return;

        if (this._removableDevices.size === 0) {
            this._indicator.hide();
            return;
        }

        const justFinished = [];

        for (const [dev, devInfo] of this._removableDevices) {
            const stats = await getBlockWriteStats(dev);
            if (!this._indicator) return;

            let st = this._devStats.get(dev);
            if (!st) {
                st = {
                    prevWrites: stats.writesCompleted,
                    prevSectors: stats.sectorsWritten,
                    totalBytesThisBurst: 0,
                    deltaBytesThisTick: 0,
                    wasWriting: false,
                    idleTicks: 0,
                    lastRateMBs: '0.0',
                };
                this._devStats.set(dev, st);
                continue;
            }

            const deltaWrites  = stats.writesCompleted - st.prevWrites;
            const deltaSectors = stats.sectorsWritten  - st.prevSectors;
            const deltaBytes   = deltaSectors * 512;
            const inFlight     = stats.inFlight > 0;

            st.prevWrites  = stats.writesCompleted;
            st.prevSectors = stats.sectorsWritten;

            const hasActivity  = deltaWrites > 0 && deltaSectors > 0;
            const avgIOSize    = hasActivity ? deltaBytes / deltaWrites : 0;
            const isLargeWrite = hasActivity &&
                                  deltaBytes >= MIN_WRITE_RATE_BYTES &&
                                  avgIOSize  >= MIN_AVG_IO_SIZE_BYTES;

            st.deltaBytesThisTick = hasActivity ? deltaBytes : 0;
            if (hasActivity) st.totalBytesThisBurst += deltaBytes;

            if (!st.wasWriting) {
                if (isLargeWrite) {
                    st.wasWriting = true;
                    st.idleTicks  = 0;
                }
            } else {
                if (hasActivity || inFlight) {
                    st.idleTicks = 0;
                } else {
                    st.idleTicks++;
                    if (st.idleTicks >= IDLE_TICKS_BEFORE_DONE) {
                        st.wasWriting          = false;
                        st.idleTicks           = 0;
                        st.totalBytesThisBurst = 0;
                        st.lastRateMBs         = '0.0';
                        // Reset anche il target: il prossimo file rilevato
                        // sarà un NUOVO trasferimento.
                        devInfo.targetFile = null;
                        devInfo.targetSize = 0;
                        justFinished.push(devInfo.label);
                    }
                }
            }

            if (st.deltaBytesThisTick > 0) {
                st.lastRateMBs = (st.deltaBytesThisTick / (1024 * 1024) / POLL_INTERVAL_SECONDS).toFixed(1);
            }
        }

        for (const name of justFinished)
            this._notifySyncComplete(name);

        // ── Costruisci indicatore ──────────────────────────────────────────
        const activeDevices = [];
        for (const [dev, devInfo] of this._removableDevices) {
            const st = this._devStats.get(dev);
            if (!st?.wasWriting) continue;
            activeDevices.push({ dev, devInfo, st });
        }

        if (activeDevices.length > 0) {
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

            // Barra grafica: mostra il progresso del device col fraction
            // più alto conosciuto tra quelli attivi (se ce n'è almeno uno).
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

    _notifySyncComplete(driveName) {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastNotifyTime < NOTIFY_COOLDOWN_MS) return;
        this._lastNotifyTime = now;

        Main.notify(
            'USB Sync Complete',
            `Write cache flushed — safe to eject ${driveName}.`,
        );
    }
}
