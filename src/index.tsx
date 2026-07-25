import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";

// SP_REACT is a global injected by the Steam/Decky runtime. We do NOT import
// react — that would leave an `import` statement in the bundle which Decky
// loads as a plain script, not an ES module.
declare const SP_REACT: any;
const { useState, useRef, useEffect, useCallback } = SP_REACT;

// SteamClient is a global injected by the Steam client runtime, used to
// re-apply intensity on resume from suspend.
declare const SteamClient: any;

type Intensity = {
  grip_left: number;
  grip_right: number;
  trig_left: number;
  trig_right: number;
};

// Module-level cache: survives panel remounts within the same plugin session.
let _cache: Intensity | null = null;

// ------------------------------------------------------------------ //
// Backend callables
// ------------------------------------------------------------------ //

const getIntensity = callable<[], Intensity>("get_intensity");

const setIntensityBackend = callable<
  [grip_left: number, grip_right: number, trig_left: number, trig_right: number],
  { success: boolean } & Intensity
>("set_intensity");

const resetToDefault = callable<[], { success: boolean } & Intensity>(
  "reset_to_default"
);

const getDeviceInfo = callable<[], { path: string | null; found: boolean }>(
  "get_device_info"
);

const testVibration = callable<[], { success: boolean } & Intensity>(
  "test_vibration"
);

const reapplyIntensity = callable<[], { success: boolean } & Intensity>(
  "reapply_intensity"
);

// ------------------------------------------------------------------ //
// Styles
// ------------------------------------------------------------------ //

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 0",
  },
  dot: (ok: boolean) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: ok ? "#4ade80" : "#f87171",
    flexShrink: 0,
  }),
  statusText: (ok: boolean) => ({
    fontSize: "11px",
    color: ok ? "#4ade80" : "#f87171",
    fontFamily: "monospace",
    wordBreak: "break-all" as const,
  }),
  valueTag: {
    fontSize: "13px",
    fontWeight: "bold",
    color: "#fff",
    background: "rgba(255,255,255,0.1)",
    borderRadius: "4px",
    padding: "1px 6px",
    fontFamily: "monospace",
  },
  warningBox: {
    background: "rgba(251,191,36,0.15)",
    border: "1px solid rgba(251,191,36,0.4)",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "11px",
    color: "rgba(251,191,36,0.9)",
    lineHeight: "1.5",
    marginTop: "4px",
  },
};

// ------------------------------------------------------------------ //
// Main component
// ------------------------------------------------------------------ //

const AllyVibeControl = () => {
  const init0 = _cache ?? {
    grip_left: 100,
    grip_right: 100,
    trig_left: 100,
    trig_right: 100,
  };

  const [gripL, setGripL] = useState<number>(init0.grip_left);
  const [gripR, setGripR] = useState<number>(init0.grip_right);
  const [trigL, setTrigL] = useState<number>(init0.trig_left);
  const [trigR, setTrigR] = useState<number>(init0.trig_right);
  const [gripLinked, setGripLinked] = useState<boolean>(
    init0.grip_left === init0.grip_right
  );
  const [trigLinked, setTrigLinked] = useState<boolean>(
    init0.trig_left === init0.trig_right
  );
  const [devicePath, setDevicePath] = useState<string | null>(null);
  const [deviceFound, setDeviceFound] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(_cache === null);
  const [applying, setApplying] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const applyTimer = useRef<ReturnType<typeof setTimeout>>();

  // Latest values ref so the debounced apply always sends the current state.
  const latest = useRef<Intensity>(init0);
  latest.current = {
    grip_left: gripL,
    grip_right: gripR,
    trig_left: trigL,
    trig_right: trigR,
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [intensity, device] = await Promise.all([
          getIntensity(),
          getDeviceInfo(),
        ]);
        _cache = intensity;
        setGripL(intensity.grip_left);
        setGripR(intensity.grip_right);
        setTrigL(intensity.trig_left);
        setTrigR(intensity.trig_right);
        setGripLinked(intensity.grip_left === intensity.grip_right);
        setTrigLinked(intensity.trig_left === intensity.trig_right);
        setDevicePath(device.path);
        setDeviceFound(device.found);
      } catch (e) {
        console.error("[ally-vibe] init error", e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const apply = useCallback((next: Intensity) => {
    clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(async () => {
      setApplying(true);
      try {
        const res = await setIntensityBackend(
          next.grip_left,
          next.grip_right,
          next.trig_left,
          next.trig_right
        );
        _cache = {
          grip_left: res.grip_left,
          grip_right: res.grip_right,
          trig_left: res.trig_left,
          trig_right: res.trig_right,
        };
      } finally {
        setApplying(false);
      }
    }, 200);
  }, []);

  const onGrip = useCallback(
    (side: "l" | "r", val: number) => {
      let l = gripL;
      let r = gripR;
      if (gripLinked) {
        l = r = val;
        setGripL(val);
        setGripR(val);
      } else if (side === "l") {
        l = val;
        setGripL(val);
      } else {
        r = val;
        setGripR(val);
      }
      apply({ ...latest.current, grip_left: l, grip_right: r });
    },
    [gripL, gripR, gripLinked, apply]
  );

  const onTrig = useCallback(
    (side: "l" | "r", val: number) => {
      let l = trigL;
      let r = trigR;
      if (trigLinked) {
        l = r = val;
        setTrigL(val);
        setTrigR(val);
      } else if (side === "l") {
        l = val;
        setTrigL(val);
      } else {
        r = val;
        setTrigR(val);
      }
      apply({ ...latest.current, trig_left: l, trig_right: r });
    },
    [trigL, trigR, trigLinked, apply]
  );

  const handleGripLink = useCallback(
    (val: boolean) => {
      setGripLinked(val);
      if (val && gripL !== gripR) {
        setGripR(gripL);
        apply({ ...latest.current, grip_left: gripL, grip_right: gripL });
      }
    },
    [gripL, gripR, apply]
  );

  const handleTrigLink = useCallback(
    (val: boolean) => {
      setTrigLinked(val);
      if (val && trigL !== trigR) {
        setTrigR(trigL);
        apply({ ...latest.current, trig_left: trigL, trig_right: trigL });
      }
    },
    [trigL, trigR, apply]
  );

  const handleReset = useCallback(async () => {
    setApplying(true);
    try {
      const res = await resetToDefault();
      _cache = {
        grip_left: res.grip_left,
        grip_right: res.grip_right,
        trig_left: res.trig_left,
        trig_right: res.trig_right,
      };
      setGripL(res.grip_left);
      setGripR(res.grip_right);
      setTrigL(res.trig_left);
      setTrigR(res.trig_right);
      setGripLinked(res.grip_left === res.grip_right);
      setTrigLinked(res.trig_left === res.trig_right);
    } finally {
      setApplying(false);
    }
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      await testVibration();
    } finally {
      setTesting(false);
    }
  }, []);

  const slider = (
    label: string,
    desc: string,
    value: number,
    onChange: (v: number) => void
  ) => (
    <PanelSectionRow>
      <SliderField
        label={label}
        description={
          <span>
            {desc}: <span style={styles.valueTag}>{value}%</span>
          </span>
        }
        value={value}
        min={0}
        max={100}
        step={5}
        disabled={applying || !deviceFound}
        onChange={onChange}
      />
    </PanelSectionRow>
  );

  if (loading) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <span>Loading...</span>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <div style={styles.container}>
      <PanelSection title="Device Status">
        <PanelSectionRow>
          <div style={styles.statusRow}>
            <div style={styles.dot(deviceFound)} />
            <span style={styles.statusText(deviceFound)}>
              {deviceFound ? devicePath ?? "Found" : "Ally X hidraw node not found"}
            </span>
          </div>
        </PanelSectionRow>
        {!deviceFound && (
          <PanelSectionRow>
            <div style={styles.warningBox}>
              No ASUS config HID interface (VID 0B05 / PID 1B4C, report 0x5A)
              was found. The plugin must run as root and the controller must be
              connected in gamepad mode.
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Grip Motors">
        <PanelSectionRow>
          <ToggleField
            label="Link left/right grip"
            checked={gripLinked}
            onChange={handleGripLink}
          />
        </PanelSectionRow>
        {gripLinked
          ? slider("Grip intensity", "Both grips", gripL, (v) => onGrip("l", v))
          : (
            <>
              {slider("Left grip", "Left grip", gripL, (v) => onGrip("l", v))}
              {slider("Right grip", "Right grip", gripR, (v) => onGrip("r", v))}
            </>
          )}
      </PanelSection>

      <PanelSection title="Trigger Motors">
        <PanelSectionRow>
          <ToggleField
            label="Link left/right trigger"
            checked={trigLinked}
            onChange={handleTrigLink}
          />
        </PanelSectionRow>
        {trigLinked
          ? slider("Trigger intensity", "Both triggers", trigL, (v) => onTrig("l", v))
          : (
            <>
              {slider("Left trigger", "Left trigger", trigL, (v) => onTrig("l", v))}
              {slider("Right trigger", "Right trigger", trigR, (v) => onTrig("r", v))}
            </>
          )}
      </PanelSection>

      <PanelSection title="Actions">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={handleTest}
            disabled={applying || testing || !deviceFound}
          >
            {testing ? "Vibrating..." : "Test (preview all motors)"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={handleReset}
            disabled={applying || testing || !deviceFound}
          >
            Reset to 100% (full)
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Notes">
        <PanelSectionRow>
          <div style={styles.warningBox}>
            Intensity is a persistent per-motor scaler applied by the
            controller MCU (report 5A D1 06), so it tunes the strength of
            in-game rumble for each motor. It is re-applied automatically after
            waking from sleep. If a game feels unchanged on the triggers,
            verify with strong trigger rumble — the trigger channels are newly
            enabled and worth confirming in a real title.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
};

// ------------------------------------------------------------------ //
// Plugin entry point
// ------------------------------------------------------------------ //

export default definePlugin(() => {
  // On resume from suspend the device re-enumerates and resets vibration
  // intensity to its default. Re-apply the saved values on wake. Registered at
  // the plugin root so it stays active while the QAM is closed.
  const resumeRegistration =
    SteamClient?.System?.RegisterForOnResumeFromSuspend?.(() => {
      reapplyIntensity().catch((e) =>
        console.error("[ally-vibe] resume reapply failed", e)
      );
    });

  return {
    name: "Ally Vibe Control",
    titleView: <span>Ally Vibe Control</span>,
    content: <AllyVibeControl />,
    icon: <span>📳</span>,
    onDismount() {
      resumeRegistration?.unregister?.();
    },
  };
});
