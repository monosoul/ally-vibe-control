import decky
import os
import glob
import fcntl
import asyncio
from settings import SettingsManager

# ------------------------------------------------------------------ #
# Constants
# ------------------------------------------------------------------ #

# ASUS ROG Ally X gamepad (USB VID:PID).
VENDOR_ID = "0B05"
PRODUCT_ID = "1B4C"

# ASUS MCU vibration-intensity command, sent as a raw HID report to the
# config interface (verified against the MCU firmware + on-device probing):
#
#   byte0: 0x5A  report id   (FEATURE_ROG_ALLY_REPORT_ID)
#   byte1: 0xD1  code page   (FEATURE_ROG_ALLY_CODE_PAGE)
#   byte2: 0x06  command     (xpad_cmd_set_vibe_intensity)
#   byte3: 0x04  length      (4 intensity channels)
#   byte4: left  grip     intensity (0-100)
#   byte5: right grip     intensity (0-100)
#   byte6: left  trigger  intensity (0-100)
#   byte7: right trigger  intensity (0-100)
#
# The stock hid_asus_ally driver only sends 2 channels (grips). The firmware
# also accepts 4, adding independent scaling for the two impulse-trigger
# motors. This value persistently scales the rumble the gamepad plays, so it
# tunes the strength of in-game vibration for each of the four motors.
REPORT_ID = 0x5A
CODE_PAGE = 0xD1
CMD_SET_VIBE = 0x06
CMD_LEN_VIBE4 = 0x04
REPORT_SIZE = 64  # FEATURE_ROG_ALLY_REPORT_SIZE

# Live force-feedback report (Output). Used only for the Test button, since the
# 0x06 intensity command is a silent scaler and produces no felt buzz on its
# own. Byte order (verified on-device):
#   0x0D, enable(0x0F), LT, RT, Lgrip, Rgrip, duration, delay, loop
RUMBLE_ID = 0x0D
RUMBLE_ENABLE = 0x0F

# Fallback node if descriptor-based discovery finds nothing.
FALLBACK_NODE = "/dev/hidraw3"

DEFAULT_INTENSITY = 100  # 0-100; 100 = full strength (no attenuation)

SETTINGS_KEYS = {
    "grip_left": "grip_left",
    "grip_right": "grip_right",
    "trig_left": "trig_left",
    "trig_right": "trig_right",
}

settings = SettingsManager(
    name="settings",
    settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR,
)


# ------------------------------------------------------------------ #
# Helpers
# ------------------------------------------------------------------ #

def _clamp(value: int, lo: int = 0, hi: int = 100) -> int:
    return max(lo, min(hi, int(value)))


def _find_config_node() -> str | None:
    """
    Locate the hidraw node for the ASUS config interface by scanning each
    node's HID report descriptor for report ID 0x5A (item byte 0x85 0x5A).
    This survives hidraw node renumbering across reboots.
    """
    for rd_path in sorted(glob.glob("/sys/class/hidraw/hidraw*/device/report_descriptor")):
        node = "/dev/" + rd_path.split("/")[4]
        uevent_path = rd_path.rsplit("/", 1)[0] + "/uevent"
        try:
            uevent = open(uevent_path).read().upper()
        except OSError:
            continue
        if VENDOR_ID not in uevent or PRODUCT_ID not in uevent:
            continue
        try:
            desc = open(rd_path, "rb").read()
        except OSError:
            continue
        # Report ID main item: 0x85 <id>. 0x5A is the ASUS config report.
        if b"\x85\x5a" in desc:
            decky.logger.info(f"[ally-vibe] config hidraw node: {node}")
            return node

    if os.path.exists(FALLBACK_NODE):
        decky.logger.warning(f"[ally-vibe] descriptor scan failed, using fallback {FALLBACK_NODE}")
        return FALLBACK_NODE
    decky.logger.error("[ally-vibe] no ASUS config hidraw node found")
    return None


def _hidiocsfeature(length: int) -> int:
    """ioctl number for HIDIOCSFEATURE(length): _IOC(WRITE|READ, 'H', 0x06, len)."""
    return (3 << 30) | (length << 16) | (ord("H") << 8) | 0x06


def _pad(payload: list[int]) -> bytes:
    return bytes(payload) + b"\x00" * (REPORT_SIZE - len(payload))


def _send_feature(node: str, payload: list[int]) -> bool:
    """Send a Feature report (SET_REPORT) - the method the MCU expects for 0x5A."""
    try:
        fd = os.open(node, os.O_RDWR)
        try:
            fcntl.ioctl(fd, _hidiocsfeature(REPORT_SIZE), bytearray(_pad(payload)))
        finally:
            os.close(fd)
        return True
    except OSError as exc:
        decky.logger.error(f"[ally-vibe] feature write to {node} failed: {exc}")
        return False


def _send_output(node: str, payload: list[int]) -> bool:
    """Send an Output report via plain write() - used for the 0x0D rumble test."""
    try:
        fd = os.open(node, os.O_RDWR)
        try:
            os.write(fd, _pad(payload))
        finally:
            os.close(fd)
        return True
    except OSError as exc:
        decky.logger.error(f"[ally-vibe] output write to {node} failed: {exc}")
        return False


def _write_intensity(grip_l: int, grip_r: int, trig_l: int, trig_r: int) -> bool:
    """Push the 4-channel vibration-intensity scaler to the MCU as a Feature report."""
    node = _find_config_node()
    if node is None:
        return False
    ok = _send_feature(node, [
        REPORT_ID, CODE_PAGE, CMD_SET_VIBE, CMD_LEN_VIBE4,
        _clamp(grip_l), _clamp(grip_r), _clamp(trig_l), _clamp(trig_r),
    ])
    if ok:
        decky.logger.info(
            f"[ally-vibe] intensity GL={grip_l} GR={grip_r} "
            f"TL={trig_l} TR={trig_r} -> {node}"
        )
    return ok


def _read_saved() -> dict:
    settings.read()
    return {
        "grip_left":  _clamp(settings.getSetting(SETTINGS_KEYS["grip_left"],  DEFAULT_INTENSITY)),
        "grip_right": _clamp(settings.getSetting(SETTINGS_KEYS["grip_right"], DEFAULT_INTENSITY)),
        "trig_left":  _clamp(settings.getSetting(SETTINGS_KEYS["trig_left"],  DEFAULT_INTENSITY)),
        "trig_right": _clamp(settings.getSetting(SETTINGS_KEYS["trig_right"], DEFAULT_INTENSITY)),
    }


# ------------------------------------------------------------------ #
# Plugin class
# ------------------------------------------------------------------ #

class Plugin:

    # ---- lifecycle ------------------------------------------------ #

    async def _main(self):
        """Called once when the plugin loads. Restore saved intensity."""
        vals = _read_saved()
        decky.logger.info(f"[ally-vibe] startup - restoring {vals}")
        _write_intensity(vals["grip_left"], vals["grip_right"],
                         vals["trig_left"], vals["trig_right"])

    async def _unload(self):
        decky.logger.info("[ally-vibe] unloaded")

    async def reapply_intensity(self) -> dict:
        """
        Re-write the saved intensity to the hardware.

        On resume from suspend the device re-enumerates and the MCU / driver
        resets vibration intensity to its default, while our saved settings are
        untouched. Re-apply them. The hidraw node may take a moment to
        re-enumerate after wake, so retry a few times.
        """
        vals = _read_saved()
        ok = False
        for attempt in range(5):
            ok = _write_intensity(vals["grip_left"], vals["grip_right"],
                                  vals["trig_left"], vals["trig_right"])
            if ok:
                break
            decky.logger.info(f"[ally-vibe] reapply attempt {attempt + 1} failed, retrying")
            await asyncio.sleep(1.0)
        decky.logger.info(f"[ally-vibe] resume reapply {vals} ok={ok}")
        return {"success": ok, **vals}

    # ---- RPC surface (called from TypeScript) --------------------- #

    async def get_intensity(self) -> dict:
        """Return current saved intensities for all four motors."""
        return _read_saved()

    async def set_intensity(self, grip_left: int, grip_right: int,
                            trig_left: int, trig_right: int) -> dict:
        """Set vibration intensity for all four motors (0-100 each)."""
        vals = {
            "grip_left":  _clamp(grip_left),
            "grip_right": _clamp(grip_right),
            "trig_left":  _clamp(trig_left),
            "trig_right": _clamp(trig_right),
        }
        # Persist intent before hitting hardware so it survives a temporarily
        # unavailable device.
        for key, val in vals.items():
            settings.setSetting(SETTINGS_KEYS[key], val)
        settings.commit()

        ok = _write_intensity(vals["grip_left"], vals["grip_right"],
                              vals["trig_left"], vals["trig_right"])
        return {"success": ok, **vals}

    async def reset_to_default(self) -> dict:
        """Reset all four motors to full strength (100%)."""
        return await self.set_intensity(DEFAULT_INTENSITY, DEFAULT_INTENSITY,
                                        DEFAULT_INTENSITY, DEFAULT_INTENSITY)

    async def test_vibration(self) -> dict:
        """
        Briefly drive all four motors via the live rumble report (0x0D) at the
        currently configured intensities, so the user can feel each motor's
        strength. The 0x06 intensity command is a silent scaler and cannot be
        felt on its own, so the test uses direct rumble instead.
        """
        vals = _read_saved()
        node = _find_config_node()
        if node is None:
            return {"success": False, **vals}

        drive = [
            RUMBLE_ID, RUMBLE_ENABLE,
            vals["trig_left"], vals["trig_right"],   # LT, RT
            vals["grip_left"], vals["grip_right"],   # Lgrip, Rgrip
            0x00, 0x00, 0x00,                        # duration, delay, loop
        ]
        stop = [RUMBLE_ID, RUMBLE_ENABLE, 0, 0, 0, 0, 0x00, 0x00, 0x00]

        ok = _send_output(node, drive)
        await asyncio.sleep(0.6)
        _send_output(node, stop)
        decky.logger.info(f"[ally-vibe] test_vibration (0x0D) {vals} ok={ok}")
        return {"success": ok, **vals}

    async def get_device_info(self) -> dict:
        """Expose discovered hidraw node for diagnostics."""
        node = _find_config_node()
        return {"path": node, "found": node is not None}
