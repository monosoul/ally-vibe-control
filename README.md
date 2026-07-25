# Ally Vibe Control

A [Decky Loader](https://decky.xyz) plugin for the **ROG Xbox Ally X** that lets you dial in exactly how hard each of the four rumble motors vibrates — the two **grips** *and* the two **impulse triggers** — or turn any of them off entirely. SteamOS gives you no per-motor control over this; motors default to full strength, which many people find uncomfortably strong.

Settings persist across reboots and are re-applied on wake from sleep.

---

## Features

- **Grip motors** — link left/right together, or set them independently
- **Trigger motors** — independent intensity for the two impulse-trigger motors (previously uncontrollable on Linux)
- **Test button** — fires a short rumble across all four motors at the current settings so you can feel the result before committing
- **Device status** — green dot when the Ally X config HID interface is detected, red if not
- **Persistent** — your chosen intensities are written back to the hardware on every Decky startup and re-applied after resume from suspend

---

## Requirements

| Requirement | Details |
|---|---|
| Device | ROG Xbox Ally X (USB `0B05:1B4C`) |
| OS | SteamOS / any Linux with Decky Loader |
| Plugin loader | [Decky Loader](https://decky.xyz) |
| Permissions | Runs as root (required for `hidraw` writes) |

> The plugin talks to the controller directly over `hidraw`, so it does **not** depend on any particular kernel driver version or sysfs endpoint. The controller must be connected in gamepad mode.

---

## Installation

### Easy install (recommended)

1. Install [Decky Loader](https://decky.xyz) if you haven't already.
2. Go to the [Releases](https://github.com/piyush-tyagi-13/ally-vibe-control/releases) page and download `ally-vibe-control-vX.X.X.zip`.
3. In Gaming Mode, open the **Quick Access Menu** (the `…` button).
4. Open the Decky menu → scroll to the bottom → **Developer** → **Install Plugin from ZIP**.
5. Select the zip you downloaded.
6. The 📳 icon will appear in the Quick Access Menu.

### From source

```bash
# Clone the repo
git clone https://github.com/piyush-tyagi-13/ally-vibe-control.git
cd ally-vibe-control

# Install dependencies and build
cd src
pnpm install
pnpm run build
cd ..

# Copy to Decky plugins directory
cp -r . ~/homebrew/plugins/ally-vibe-control

# Restart Decky
systemctl --user restart plugin_loader
```

Requires Node.js 16.14+ and pnpm v9 (`npm install -g pnpm@9`).

---

## Usage

Open the **Quick Access Menu** and tap the 📳 icon.

**Grip Motors**
The "Link left/right grip" toggle keeps both grips in sync (single slider). Toggle it off to reveal separate left/right sliders — useful if one grip feels stronger than the other, or you prefer an asymmetric feel.

**Trigger Motors**
Same layout for the two impulse-trigger motors. Set them lower than the grips (or to 0) if you find trigger buzz distracting, or crank them up for stronger trigger feedback.

**Test**
Fires a short rumble across all four motors at the current settings so you can feel the result without launching a game. Adjust → test → repeat until it feels right.

**Reset to 100%**
Restores every motor to full strength (factory behavior).

---

## How it works

The plugin sends the ASUS MCU vibration-intensity command directly to the controller's config HID interface as a **Feature report**:

```
byte0: 0x5A   report id      (FEATURE_ROG_ALLY_REPORT_ID)
byte1: 0xD1   code page      (FEATURE_ROG_ALLY_CODE_PAGE)
byte2: 0x06   command        (set vibration intensity)
byte3: 0x04   length         (4 channels)
byte4: left  grip     intensity (0-100)
byte5: right grip     intensity (0-100)
byte6: left  trigger  intensity (0-100)
byte7: right trigger  intensity (0-100)
```

The stock `hid_asus_ally` driver only sends two channels (grips). The MCU firmware also honors a four-channel form, which adds independent scaling for the two impulse-trigger motors — this value persistently scales the rumble the gamepad plays, so it tunes in-game vibration strength per motor.

The correct `hidraw` node is discovered by scanning each interface's HID report descriptor for report ID `0x5A`, so it survives `hidraw` node renumbering across reboots. The **Test** button uses the live force-feedback report (`0x0D`) to drive the motors directly, since the `0x06` intensity command is a silent scaler and produces no felt buzz on its own. The plugin runs as root (required for `hidraw` writes) and uses Decky's `SettingsManager` to persist your values.

---

## Troubleshooting

### Plugin doesn't appear in the Quick Access Menu

```bash
ls ~/homebrew/plugins/ally-vibe-control/          # plugin present?
ls ~/homebrew/plugins/ally-vibe-control/dist/index.js   # frontend bundle present?
systemctl status plugin_loader                    # Decky running?
systemctl --user restart plugin_loader            # restart Decky
```

### Device Status shows a red dot

The plugin couldn't find a `hidraw` node for the Ally X config interface (VID `0B05` / PID `1B4C`, report `0x5A`). Confirm the controller is connected in gamepad mode:

```bash
# List Ally X hidraw interfaces and their report IDs
for rd in /sys/class/hidraw/hidraw*/device/report_descriptor; do
  ue=$(cat "${rd%/*}/uevent")
  case "$ue" in *0B05*1B4C*)
    echo "/dev/$(echo "$rd" | cut -d/ -f5): $(grep -o 'HID_ID=[^ ]*' <<<"$ue")" ;;
  esac
done
```

### Sliders move but vibration doesn't change

```bash
# Check plugin logs
sudo cat ~/homebrew/logs/ally-vibe-control/*.log | tail -30
```

Verify `plugin.json` contains `"flags": ["root"]` (needed for `hidraw` writes). Note the intensity is a *scaler* on game rumble — to feel it change, use the **Test** button or trigger rumble in a game; setting intensity alone does not buzz.

---

## Building a release

Tag a commit and push — GitHub Actions handles the rest:

```bash
git tag v1.1.0
git push origin v1.1.0
```

The workflow builds the frontend, packages the zip, and publishes a GitHub Release with install instructions automatically.

---

## License

MIT — see [LICENSE](LICENSE).
