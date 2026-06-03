# True USB Write Progress

A GNOME Shell extension that monitors real-time kernel dirty-cache writes destined for removable USB block devices. It displays a top-bar indicator with live write speed and total bytes transferred, and notifies you when the flush is complete so you know exactly when a drive is safe to eject.

[![GNOME Extensions](https://img.shields.io/badge/GNOME_Extensions-Install-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/extension/10082/true-usb-write-progress/)

## The Problem

When you copy files to a USB drive on Linux, the file manager often reports the operation as "complete" while the data is still sitting in the kernel's write-back cache. Ejecting the drive at this point can result in data corruption. There is no built-in visual feedback for the actual flush progress.

This extension solves that by reading per-device I/O counters directly from `/sys/block/<dev>/stat` and applying heuristic filtering to distinguish real file writes from routine metadata chatter.

## Compatibility

| GNOME Shell | Status    |
|-------------|-----------|
| 45          | Supported |
| 46          | Supported |
| 47          | Supported |
| 48          | Supported |
| 49          | Supported |
| 50          | Supported |

Uses ESM imports (`gi://`). No legacy `imports.gi` compatibility.

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/ktauchathuranga/true-usb-progress.git

# Create the extension directory
mkdir -p ~/.local/share/gnome-shell/extensions/true-usb-progress@ktauchathuranga.github.io

# Copy extension files
cp extension.js metadata.json \
   ~/.local/share/gnome-shell/extensions/true-usb-progress@ktauchathuranga.github.io/

# Restart GNOME Shell (X11: Alt+F2, type 'r', Enter)
# On Wayland: log out and log back in

# Enable the extension
gnome-extensions enable true-usb-progress@ktauchathuranga.github.io
```

### Verify Installation

```bash
gnome-extensions list | grep true-usb-progress
gnome-extensions info true-usb-progress@ktauchathuranga.github.io
```

## Architecture

```
+---------------------+       +----------------------------+
|   UDisks2 (D-Bus)   |       |  /sys/block/<dev>/stat     |
|                     |       |  (kernel block-layer I/O)  |
+--------+------------+       +-------------+--------------+
         |                                  |
         | GetManagedObjects                | readFileSync()
         | InterfacesAdded/Removed          | every 2 seconds
         |                                  |
+--------v----------------------------------v--------------+
|                                                          |
|              TrueUsbProgressExtension                    |
|                                                          |
|  _removableDevices   Map<devName, { label }>             |
|  _devStats           Map<devName, DeviceState>           |
|                                                          |
|  Per-device two-phase state machine:                     |
|    Phase 1 (TRIGGER)  -->  Phase 2 (SUSTAIN)  -->  DONE  |
|                                                          |
+--------+-------------------------+-----------------------+
         |                         |
         v                         v
  PanelMenu.Button           Main.notify()
  (top-bar indicator)        ("safe to eject")
```

### Component Breakdown

**Device Discovery (UDisks2 D-Bus)**

The extension connects to the system bus and calls `GetManagedObjects` on `org.freedesktop.UDisks2` to enumerate all block devices. It filters for devices where:

1. The parent `Drive` interface has `Removable == true` and `ConnectionBus == "usb"`
2. The block device exposes an `org.freedesktop.UDisks2.Filesystem` interface (i.e., it is mounted)

It subscribes to `InterfacesAdded` and `InterfacesRemoved` signals to dynamically track USB hotplug and mount/unmount events without polling D-Bus.

**I/O Monitoring (`/sys/block/<dev>/stat`)**

Every 2 seconds, the extension reads the kernel's block-layer statistics for each tracked device. The relevant fields from `/sys/block/<dev>/stat` are:

| Field Index | Name              | Description                            |
|-------------|-------------------|----------------------------------------|
| 4           | writes completed  | Total completed write requests         |
| 6           | sectors written   | Total 512-byte sectors written         |
| 8           | in-flight I/Os    | Currently queued I/O operations        |

Partition names (e.g., `sdb1`) are automatically resolved to parent disk names (e.g., `sdb`) since `/sys/block/` only contains whole-disk entries. This resolution handles SCSI/USB (`sdXN`), NVMe (`nvmeXnYpZ`), and MMC (`mmcblkNpM`) naming schemes.

**Two-Phase Write Detection**

A per-device state machine prevents false positives from small metadata writes (journal commits, inode updates, directory entries) while maintaining indicator visibility during legitimate file copy operations:

**Phase 1 -- TRIGGER (strict thresholds)**

Both conditions must be met simultaneously to start tracking a write burst:

- Delta bytes >= 64 KB per tick (~32 KB/s at 2-second polling)
- Average I/O request size >= 16 KB

Small, frequent writes typical of filesystem metadata will not pass these thresholds.

**Phase 2 -- SUSTAIN (permissive)**

Once triggered, any write activity (even small sector changes or in-flight I/O) keeps the indicator alive. This prevents the indicator from flickering off during gaps between kernel writeback rounds.

**DONE (idle detection)**

The burst ends only after 5 consecutive idle ticks (10 seconds) with zero sector changes and zero in-flight I/O. This generous grace period accounts for the bursty nature of Linux's writeback mechanism.

```
              +------------------+
              |     IDLE         |
              | (indicator off)  |
              +--------+---------+
                       |
                       | large write detected
                       | (>= 64KB/tick AND >= 16KB avg I/O)
                       v
              +------------------+
              |    WRITING       |
              | (indicator on)   |<---+
              +--------+---------+    |
                       |              | any activity or
                       |              | in-flight I/O
                       |              |
              +--------v---------+    |
              |   IDLE TICK?     +----+
              | sector_delta==0  |
              | && in_flight==0  |
              +--------+---------+
                       |
                       | 5 consecutive idle ticks (10s)
                       v
              +------------------+
              |     DONE         |
              | notify + reset   |
              +------------------+
```

**Indicator (Top Bar)**

A `PanelMenu.Button` with a USB drive icon and a dynamic label. Hidden when no writes are active. When one or more devices are writing, the label shows:

```
DEVICE_LABEL: 123.4 MB (5.2 MB/s) · DEVICE_2: 45.0 MB
```

- Total bytes written in the current burst
- Live write speed (updated each tick when new data arrives)
- Multiple active devices are separated by ` · `
- Speed display is suppressed when a device is in a writeback gap (shows only total)

**Notifications**

When a device transitions from WRITING to DONE, a desktop notification fires:

> **USB Sync Complete**
> Write cache flushed -- safe to eject DEVICE_LABEL.

A 10-second cooldown prevents notification spam when multiple devices finish in quick succession.

## Configuration

The extension currently has no user-configurable settings (no GSettings schema). All thresholds are compile-time constants in `extension.js`:

| Constant                 | Default   | Description                                          |
|--------------------------|-----------|------------------------------------------------------|
| `POLL_INTERVAL_SECONDS`  | `2`       | Seconds between I/O stat reads                       |
| `NOTIFY_COOLDOWN_MS`     | `10000`   | Minimum ms between "safe to eject" notifications     |
| `MIN_WRITE_RATE_BYTES`   | `65536`   | Minimum bytes/tick to trigger Phase 1 (64 KB)        |
| `MIN_AVG_IO_SIZE_BYTES`  | `16384`   | Minimum average I/O request size for Phase 1 (16 KB) |
| `IDLE_TICKS_BEFORE_DONE` | `5`       | Consecutive idle ticks before declaring DONE          |

## File Structure

```
true-usb-progress@ktauchathuranga.github.io/
  extension.js    -- Extension logic (single-file, ~550 lines)
  metadata.json   -- GNOME Shell extension manifest
```

## Dependencies

- **Runtime**: GNOME Shell 45+, UDisks2 (present on all standard GNOME installations)
- **System interfaces**: `/sys/block/*/stat` (Linux sysfs, always available)
- **D-Bus**: System bus access to `org.freedesktop.UDisks2`
- **No external libraries or build tools required**

## How It Works (Summary)

1. On `enable()`, connects to UDisks2 over D-Bus and enumerates mounted USB drives
2. Subscribes to D-Bus signals for dynamic hotplug/unmount tracking
3. Starts a 2-second GLib polling loop
4. Each tick: reads `/sys/block/<dev>/stat` for every tracked device, computes sector deltas
5. Per-device state machine filters metadata writes and tracks real file copy bursts
6. Top-bar indicator shows live progress; hides when idle
7. Desktop notification fires when all pending writes are flushed
8. On `disable()`, all timers, signal subscriptions, and UI elements are cleaned up

## Debugging

Monitor extension logs in real time:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Look for log lines prefixed with `[TrueUsbProgress]`:

```
[TrueUsbProgress] Tracking USB device: /dev/sdb1 ("MY_USB")
```

## License

This project is open source. See the repository for license details.
