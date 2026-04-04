// ============================================================
// Presence-Thermostat Recipe — external package
// ============================================================

// Minimal types for RecipeContext (injected at runtime by Sowel core)
interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): {
      name: string;
      zoneId?: string;
      dataBindings: Array<{ alias: string }>;
      orderBindings: Array<{ alias: string; enumValues?: string[] }>;
    } | null;
    executeOrder(
      equipmentId: string,
      alias: string,
      value: unknown,
    ): Promise<{ success: boolean; error?: string }>;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  zoneAggregator: {
    getByZoneId(zoneId: string): {
      motion: boolean;
      motionSensors: number;
    } | null;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeActionDef {
  id: string;
  type: "cycle";
  stateKey: string;
  options: { value: string; label: string }[];
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
  groups?: Record<string, string>;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: RecipeActionDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): { stop(): void; onAction?(action: string, payload?: Record<string, unknown>): void };
}

// ============================================================
// Helpers
// ============================================================

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === "string");
  }
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").filter(Boolean);
  }
  return [];
}

function isInTimeWindow(now: Date, startTime: string, endTime: string): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day range (e.g., 06:00 to 08:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range (e.g., 22:00 to 06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function validateTimePair(
  params: Record<string, unknown>,
  startKey: string,
  endKey: string,
): void {
  const start = params[startKey];
  const end = params[endKey];
  const hasStart = start !== undefined && start !== null && start !== "";
  const hasEnd = end !== undefined && end !== null && end !== "";

  if (hasStart !== hasEnd) {
    throw new Error(`${startKey} and ${endKey} must both be provided or both omitted`);
  }
  if (hasStart && typeof start === "string" && !/^\d{2}:\d{2}$/.test(start)) {
    throw new Error(`${startKey} must be in HH:MM format`);
  }
  if (hasEnd && typeof end === "string" && !/^\d{2}:\d{2}$/.test(end)) {
    throw new Error(`${endKey} must be in HH:MM format`);
  }
}

// ============================================================
// Recipe Definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "presence-thermostat",
    name: "Presence Thermostat",
    description:
      "Adjusts thermostat setpoint based on zone presence. Sends comfort temperature when motion is detected, switches to eco after a timeout with no motion. Supports night mode (fixed setpoint during night window, ignoring presence), weekday/weekend preheat windows, cocoon mode (button-triggered boost), and manual override detection.",

    slots: [
      {
        id: "zone",
        name: "Zone",
        description: "Zone to monitor for presence",
        type: "zone",
        required: true,
      },
      {
        id: "thermostat",
        name: "Thermostat",
        description: "Thermostat equipment (must have a 'setpoint' order binding)",
        type: "equipment",
        required: true,
        constraints: { equipmentType: "thermostat" },
      },
      {
        id: "comfortTemp",
        name: "Comfort Temperature",
        description: "Setpoint when presence is detected (°C)",
        type: "number",
        required: true,
      },
      {
        id: "ecoTemp",
        name: "Eco Temperature",
        description: "Setpoint after absence timeout (°C)",
        type: "number",
        required: true,
      },
      {
        id: "timeout",
        name: "Timeout",
        description: "Delay with no motion before switching to eco",
        type: "duration",
        required: true,
        defaultValue: "30m",
      },
      {
        id: "nightTemp",
        name: "Night Temperature",
        description:
          "Fixed setpoint during the night window, regardless of presence (°C, optional)",
        type: "number",
        required: false,
        group: "night",
      },
      {
        id: "nightStart",
        name: "Night Start",
        description: "Start of night window (HH:MM)",
        type: "time",
        required: false,
        group: "night",
      },
      {
        id: "nightEnd",
        name: "Night End",
        description: "End of night window (HH:MM)",
        type: "time",
        required: false,
        group: "night",
      },
      {
        id: "preheatStart",
        name: "Preheat Start (Weekday)",
        description: "Start of weekday preheat window (HH:MM, Mon-Fri)",
        type: "time",
        required: false,
        group: "preheat",
      },
      {
        id: "preheatEnd",
        name: "Preheat End (Weekday)",
        description: "End of weekday preheat window (HH:MM, Mon-Fri)",
        type: "time",
        required: false,
        group: "preheat",
      },
      {
        id: "weekendPreheatStart",
        name: "Preheat Start (Weekend)",
        description: "Start of weekend preheat window (HH:MM, Sat-Sun)",
        type: "time",
        required: false,
        group: "preheat",
      },
      {
        id: "weekendPreheatEnd",
        name: "Preheat End (Weekend)",
        description: "End of weekend preheat window (HH:MM, Sat-Sun)",
        type: "time",
        required: false,
        group: "preheat",
      },
      {
        id: "buttons",
        name: "Cocoon Buttons",
        description: "Button equipments that toggle cocoon mode (optional)",
        type: "equipment",
        required: false,
        list: true,
        constraints: { equipmentType: "button" },
        group: "cocoon",
      },
      {
        id: "cocoonTemp",
        name: "Cocoon Temperature",
        description: "Boosted setpoint when cocoon is activated by button (°C)",
        type: "number",
        required: false,
        group: "cocoon",
      },
    ],

    actions: [
      {
        id: "set_mode",
        type: "cycle",
        stateKey: "currentMode",
        options: [
          { value: "eco", label: "Eco" },
          { value: "comfort", label: "Comfort" },
          { value: "cocoon", label: "Cocoon" },
          { value: "night", label: "Night" },
        ],
      },
    ],

    i18n: {
      fr: {
        name: "Thermostat présence",
        description:
          "Ajuste la consigne du thermostat en fonction de la présence dans la zone. Envoie la température confort quand un mouvement est détecté, passe en éco après un délai sans mouvement. Supporte un mode nuit (consigne fixe pendant la plage nocturne, indépendamment de la présence), des plages de préchauffe semaine/week-end, un mode cocoon (boost par bouton), et la détection de changement manuel.",
        slots: {
          zone: { name: "Zone", description: "Zone à surveiller" },
          thermostat: {
            name: "Thermostat",
            description: "Équipement thermostat (doit avoir un binding d'ordre 'setpoint')",
          },
          comfortTemp: {
            name: "Température confort",
            description: "Consigne quand il y a de la présence (°C)",
          },
          ecoTemp: {
            name: "Température éco",
            description: "Consigne après le délai d'absence (°C)",
          },
          timeout: {
            name: "Délai",
            description: "Délai sans mouvement avant passage en éco",
          },
          nightTemp: {
            name: "Température nuit",
            description:
              "Consigne fixe appliquée pendant la plage nocturne, indépendamment de la présence (°C, optionnel)",
          },
          nightStart: {
            name: "Début nuit",
            description: "Début de la plage nocturne (HH:MM)",
          },
          nightEnd: { name: "Fin nuit", description: "Fin de la plage nocturne (HH:MM)" },
          preheatStart: {
            name: "Début préchauffe (semaine)",
            description: "Début de la préchauffe en semaine (HH:MM, lun-ven)",
          },
          preheatEnd: {
            name: "Fin préchauffe (semaine)",
            description: "Fin de la préchauffe en semaine (HH:MM, lun-ven)",
          },
          weekendPreheatStart: {
            name: "Début préchauffe (week-end)",
            description: "Début de la préchauffe le week-end (HH:MM, sam-dim)",
          },
          weekendPreheatEnd: {
            name: "Fin préchauffe (week-end)",
            description: "Fin de la préchauffe le week-end (HH:MM, sam-dim)",
          },
          buttons: {
            name: "Boutons cocoon",
            description: "Boutons qui activent le mode cocoon (optionnel)",
          },
          cocoonTemp: {
            name: "Température cocoon",
            description: "Consigne boostée quand le cocoon est activé par bouton (°C)",
          },
        },
        groups: {
          night: "Nuit",
          preheat: "Préchauffe",
          cocoon: "Cocoon",
        },
      },
      en: {
        name: "Presence Thermostat",
        description:
          "Adjusts thermostat setpoint based on zone presence. Sends comfort temperature when motion is detected, switches to eco after a timeout with no motion.",
        groups: {
          night: "Night",
          preheat: "Preheat",
          cocoon: "Cocoon",
        },
      },
    },

    // ── Validation ─────────────────────────────────────────

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      const { zone, thermostat, comfortTemp, ecoTemp, timeout } = params;

      // Validate zone
      if (!zone || typeof zone !== "string") {
        throw new Error("Zone parameter is required");
      }
      const zoneObj = ctx.zoneManager.getById(zone);
      if (!zoneObj) {
        throw new Error(`Zone not found: ${zone}`);
      }
      const zoneData = ctx.zoneAggregator.getByZoneId(zone);
      if (zoneData && zoneData.motionSensors === 0) {
        ctx.log(
          "Zone has no motion sensors — recipe will only work with preheat windows",
          "warn",
        );
      }

      // Validate thermostat
      if (!thermostat || typeof thermostat !== "string") {
        throw new Error("Thermostat parameter is required");
      }
      const equipment = ctx.equipmentManager.getByIdWithDetails(thermostat);
      if (!equipment) {
        throw new Error(`Thermostat equipment not found: ${thermostat}`);
      }
      if (equipment.zoneId !== zone) {
        throw new Error(
          `Thermostat "${equipment.name}" does not belong to the selected zone`,
        );
      }
      const hasSetpointOrder = equipment.orderBindings.some(
        (ob) => ob.alias === "setpoint",
      );
      if (!hasSetpointOrder) {
        throw new Error(
          `Thermostat "${equipment.name}" has no "setpoint" order binding`,
        );
      }

      // Validate temperatures
      if (comfortTemp === undefined || comfortTemp === null) {
        throw new Error("comfortTemp is required");
      }
      if (isNaN(Number(comfortTemp))) {
        throw new Error("comfortTemp must be a number");
      }
      if (ecoTemp === undefined || ecoTemp === null) {
        throw new Error("ecoTemp is required");
      }
      if (isNaN(Number(ecoTemp))) {
        throw new Error("ecoTemp must be a number");
      }

      // Validate timeout
      ctx.helpers.parseDuration(timeout || "30m");

      // Validate night window
      const { nightTemp: nt, nightStart: ns, nightEnd: ne } = params;
      const hasNightTemp = nt !== undefined && nt !== null && nt !== "";
      const hasNightStart = ns !== undefined && ns !== null && ns !== "";
      const hasNightEnd = ne !== undefined && ne !== null && ne !== "";

      if (hasNightTemp && (!hasNightStart || !hasNightEnd)) {
        throw new Error("nightTemp requires nightStart and nightEnd");
      }
      if ((hasNightStart || hasNightEnd) && !hasNightTemp) {
        throw new Error("nightStart/nightEnd require nightTemp");
      }
      if (hasNightStart && hasNightEnd) {
        if (typeof ns === "string" && !/^\d{2}:\d{2}$/.test(ns)) {
          throw new Error("nightStart must be in HH:MM format");
        }
        if (typeof ne === "string" && !/^\d{2}:\d{2}$/.test(ne)) {
          throw new Error("nightEnd must be in HH:MM format");
        }
      }
      if (hasNightTemp && isNaN(Number(nt))) {
        throw new Error("nightTemp must be a number");
      }

      // Validate preheat weekday
      validateTimePair(params, "preheatStart", "preheatEnd");

      // Validate preheat weekend
      validateTimePair(params, "weekendPreheatStart", "weekendPreheatEnd");

      // Validate cocoon (buttons + cocoonTemp must be provided together)
      const buttonIds = normalizeStringArray(params.buttons);
      const hasCocoonTemp =
        params.cocoonTemp !== undefined &&
        params.cocoonTemp !== null &&
        params.cocoonTemp !== "";

      if (buttonIds.length > 0 && !hasCocoonTemp) {
        throw new Error("cocoonTemp is required when buttons are configured");
      }
      if (hasCocoonTemp && buttonIds.length === 0) {
        throw new Error("buttons are required when cocoonTemp is configured");
      }
      if (hasCocoonTemp && isNaN(Number(params.cocoonTemp))) {
        throw new Error("cocoonTemp must be a number");
      }

      // Validate each button has an "action" data binding
      for (const buttonId of buttonIds) {
        const btn = ctx.equipmentManager.getByIdWithDetails(buttonId);
        if (!btn) {
          throw new Error(`Button equipment not found: ${buttonId}`);
        }
        const hasActionData = btn.dataBindings.some((db) => db.alias === "action");
        if (!hasActionData) {
          throw new Error(`Button "${btn.name}" has no "action" data binding`);
        }
      }
    },

    // ── Instance factory ───────────────────────────────────

    createInstance(params: Record<string, unknown>, ctx: RecipeContext) {
      // ── Parse parameters ─────────────────────────────────
      const zoneId = params.zone as string;
      const thermostatId = params.thermostat as string;
      const comfortTemp = Number(params.comfortTemp);
      const ecoTemp = Number(params.ecoTemp);
      const timeoutMs = ctx.helpers.parseDuration(params.timeout || "30m");

      // Night window
      const nightTemp =
        params.nightTemp !== undefined && params.nightTemp !== null && params.nightTemp !== ""
          ? Number(params.nightTemp)
          : null;
      const nightStart =
        typeof params.nightStart === "string" && params.nightStart
          ? params.nightStart
          : null;
      const nightEnd =
        typeof params.nightEnd === "string" && params.nightEnd ? params.nightEnd : null;

      // Preheat windows
      const preheatStart =
        typeof params.preheatStart === "string" && params.preheatStart
          ? params.preheatStart
          : null;
      const preheatEnd =
        typeof params.preheatEnd === "string" && params.preheatEnd
          ? params.preheatEnd
          : null;
      const weekendPreheatStart =
        typeof params.weekendPreheatStart === "string" && params.weekendPreheatStart
          ? params.weekendPreheatStart
          : null;
      const weekendPreheatEnd =
        typeof params.weekendPreheatEnd === "string" && params.weekendPreheatEnd
          ? params.weekendPreheatEnd
          : null;

      // Cocoon
      const buttonIds = normalizeStringArray(params.buttons);
      const cocoonTemp =
        params.cocoonTemp !== undefined &&
        params.cocoonTemp !== null &&
        params.cocoonTemp !== ""
          ? Number(params.cocoonTemp)
          : null;

      // ── Runtime state (closure variables) ────────────────
      let currentMode: "comfort" | "eco" | "cocoon" | "night" = "eco";
      let overrideMode = false;
      let lastSentSetpoint: number | null = null;
      let setpointGraceUntil = 0;
      let ecoTimer: ReturnType<typeof setTimeout> | null = null;
      let periodicCheckTimer: ReturnType<typeof setInterval> | null = null;
      let wasInPreheat = false;
      let wasInNight = false;
      const unsubs: (() => void)[] = [];

      // ── Night window helpers ─────────────────────────────

      function hasNightConfig(): boolean {
        return nightStart !== null && nightEnd !== null && nightTemp !== null;
      }

      function isInNightWindow(): boolean {
        if (!hasNightConfig()) return false;
        return isInTimeWindow(new Date(), nightStart!, nightEnd!);
      }

      // ── Preheat helpers ──────────────────────────────────

      function hasPreheatConfig(): boolean {
        return (
          (preheatStart !== null && preheatEnd !== null) ||
          (weekendPreheatStart !== null && weekendPreheatEnd !== null)
        );
      }

      function needsPeriodicCheck(): boolean {
        return hasPreheatConfig() || hasNightConfig();
      }

      function isInPreheatWindow(): boolean {
        if (!hasPreheatConfig()) return false;

        const now = new Date();
        const day = now.getDay(); // 0=Sun, 6=Sat
        const isWeekend = day === 0 || day === 6;

        if (isWeekend && weekendPreheatStart !== null && weekendPreheatEnd !== null) {
          return isInTimeWindow(now, weekendPreheatStart, weekendPreheatEnd);
        }
        if (!isWeekend && preheatStart !== null && preheatEnd !== null) {
          return isInTimeWindow(now, preheatStart, preheatEnd);
        }

        return false;
      }

      // ── Motion state helper ──────────────────────────────

      function hasMotion(): boolean {
        const zoneData = ctx.zoneAggregator.getByZoneId(zoneId);
        return zoneData?.motion ?? false;
      }

      // ── Eco timer management ─────────────────────────────

      function cancelEcoTimer(): void {
        if (ecoTimer) {
          clearTimeout(ecoTimer);
          ecoTimer = null;
        }
      }

      function persistTimerState(): void {
        const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
        ctx.state.set("timerExpiresAt", expiresAt);
      }

      function clearTimerState(): void {
        ctx.state.delete("timerExpiresAt");
      }

      // ── Cocoon state management ──────────────────────────

      function clearCocoonState(): void {
        ctx.state.delete("cocoonMode");
      }

      // ── Override management ──────────────────────────────

      function clearOverrideMode(): void {
        if (!overrideMode) return;
        overrideMode = false;
        ctx.state.delete("overrideMode");
      }

      // ── Actions ──────────────────────────────────────────

      function setComfort(reason: string): void {
        const target = comfortTemp;
        currentMode = "comfort";
        ctx.state.set("currentMode", "comfort");
        setpointGraceUntil = Date.now() + 5000;
        lastSentSetpoint = target;
        ctx.equipmentManager
          .executeOrder(thermostatId, "setpoint", target)
          .then((r) => {
            if (!r.success)
              ctx.log(`Setpoint → ${target}°C FAILED: ${r.error}`, "error");
          })
          .catch((err) =>
            ctx.log(`Error setting comfort setpoint: ${String(err)}`, "error"),
          );
        clearCocoonState();
        ctx.log(`${reason} — setpoint → ${target}°C (comfort)`);
      }

      function setEco(reason: string): void {
        currentMode = "eco";
        ctx.state.set("currentMode", "eco");
        setpointGraceUntil = Date.now() + 5000;
        lastSentSetpoint = ecoTemp;
        ctx.equipmentManager
          .executeOrder(thermostatId, "setpoint", ecoTemp)
          .then((r) => {
            if (!r.success)
              ctx.log(`Setpoint → ${ecoTemp}°C FAILED: ${r.error}`, "error");
          })
          .catch((err) =>
            ctx.log(`Error setting eco setpoint: ${String(err)}`, "error"),
          );
        clearCocoonState();
        clearOverrideMode();
        ctx.log(`${reason} — setpoint → ${ecoTemp}°C (eco)`);
      }

      function setCocoon(reason: string): void {
        currentMode = "cocoon";
        ctx.state.set("currentMode", "cocoon");
        ctx.state.set("cocoonMode", true);
        cancelEcoTimer();
        clearTimerState();
        setpointGraceUntil = Date.now() + 5000;
        lastSentSetpoint = cocoonTemp!;
        ctx.equipmentManager
          .executeOrder(thermostatId, "setpoint", cocoonTemp!)
          .then((r) => {
            if (!r.success)
              ctx.log(`Setpoint → ${cocoonTemp}°C FAILED: ${r.error}`, "error");
          })
          .catch((err) =>
            ctx.log(`Error setting cocoon setpoint: ${String(err)}`, "error"),
          );
        ctx.log(`${reason} — setpoint → ${cocoonTemp}°C (cocoon)`);
      }

      function setNight(reason: string): void {
        currentMode = "night";
        ctx.state.set("currentMode", "night");
        cancelEcoTimer();
        clearTimerState();
        setpointGraceUntil = Date.now() + 5000;
        lastSentSetpoint = nightTemp!;
        ctx.equipmentManager
          .executeOrder(thermostatId, "setpoint", nightTemp!)
          .then((r) => {
            if (!r.success)
              ctx.log(`Setpoint → ${nightTemp}°C FAILED: ${r.error}`, "error");
          })
          .catch((err) =>
            ctx.log(`Error setting night setpoint: ${String(err)}`, "error"),
          );
        clearCocoonState();
        ctx.log(`${reason} — setpoint → ${nightTemp}°C (night)`);
      }

      // ── Eco timer starters ───────────────────────────────

      function startEcoTimer(): void {
        cancelEcoTimer();
        ecoTimer = setTimeout(() => {
          ecoTimer = null;
          clearTimerState();
          setEco(`No motion for ${ctx.helpers.formatDuration(timeoutMs)}`);
        }, timeoutMs);
        persistTimerState();
      }

      function startEcoTimerForOverrideClear(): void {
        cancelEcoTimer();
        ecoTimer = setTimeout(() => {
          ecoTimer = null;
          clearTimerState();
          setEco(
            `No motion for ${ctx.helpers.formatDuration(timeoutMs)} — override cleared`,
          );
        }, timeoutMs);
        persistTimerState();
      }

      // ── Event handlers ───────────────────────────────────

      function onZoneChanged(motion: boolean): void {
        // Night mode: fixed setpoint, ignore presence changes
        if (currentMode === "night") return;

        // Override mode: recipe is suspended, only track room vacancy
        if (overrideMode) {
          if (motion) {
            cancelEcoTimer();
            clearTimerState();
          } else {
            startEcoTimerForOverrideClear();
          }
          return;
        }

        if (motion) {
          // Presence detected
          cancelEcoTimer();
          clearTimerState();

          if (currentMode === "eco") {
            setComfort("Motion detected");
          }
          // If cocoon or comfort → stay in current mode, just cancel eco timer
        } else {
          // No motion — preheat protects comfort but NOT cocoon
          if (currentMode === "comfort" && isInPreheatWindow()) {
            cancelEcoTimer();
            clearTimerState();
            return;
          }

          if (currentMode === "comfort" || currentMode === "cocoon") {
            startEcoTimer();
          }
        }
      }

      function onSetpointChanged(value: unknown): void {
        if (overrideMode) return;
        if (Date.now() < setpointGraceUntil) return;
        // Ignore echo: same value as what the recipe sent
        if (lastSentSetpoint !== null && Number(value) === lastSentSetpoint) return;

        overrideMode = true;
        ctx.state.set("overrideMode", true);
        ctx.log("Manual setpoint change detected — entering override mode");
      }

      function onButtonAction(): void {
        // Ignore during override or night mode
        if (overrideMode) return;
        if (currentMode === "night") return;

        if (currentMode === "cocoon") {
          // Second press → exit cocoon
          cancelEcoTimer();
          clearTimerState();
          if (hasMotion()) {
            setComfort("Cocoon deactivated by button — motion present");
          } else {
            setEco("Cocoon deactivated by button — no motion");
          }
        } else {
          // Enter cocoon from any non-override mode
          setCocoon("Button pressed");
        }
      }

      // ── Periodic check transitions ───────────────────────

      function checkPreheatTransition(): void {
        if (overrideMode) {
          // Track preheat state but don't act during override
          wasInPreheat = isInPreheatWindow();
          return;
        }

        const inPreheat = isInPreheatWindow();

        // Entering preheat window
        if (inPreheat && !wasInPreheat) {
          cancelEcoTimer();
          clearTimerState();
          if (currentMode === "eco") {
            setComfort("Preheat window started");
          }
        }

        // Leaving preheat window
        if (!inPreheat && wasInPreheat) {
          if (currentMode === "comfort" && !hasMotion()) {
            startEcoTimer();
          }
        }

        wasInPreheat = inPreheat;
      }

      function checkPeriodicTransitions(): void {
        // Night window transitions (auto-enter/exit)
        const inNight = isInNightWindow();
        if (inNight && !wasInNight) {
          // Entering night window → force night mode
          cancelEcoTimer();
          clearTimerState();
          setNight("Night window started");
          wasInNight = true;
          wasInPreheat = isInPreheatWindow();
          return;
        }
        if (!inNight && wasInNight) {
          // Leaving night window → resume normal behavior
          wasInNight = false;
          if (currentMode === "night") {
            cancelEcoTimer();
            clearTimerState();
            if (isInPreheatWindow()) {
              setComfort("Night ended — preheat window active");
            } else if (hasMotion()) {
              setComfort("Night ended — motion detected");
            } else {
              setEco("Night ended — no motion");
            }
          }
        }
        wasInNight = inNight;

        // Preheat transitions (skip during night mode)
        if (currentMode !== "night") {
          checkPreheatTransition();
        }
      }

      // ── Initial sync ─────────────────────────────────────

      function syncOnStart(): void {
        // Night mode takes priority — fixed setpoint regardless of presence
        if (isInNightWindow()) {
          setNight("Recipe activated — night window active");
          return;
        }

        const zoneData = ctx.zoneAggregator.getByZoneId(zoneId);
        const motion = zoneData?.motion ?? false;

        if (isInPreheatWindow()) {
          setComfort("Recipe activated — preheat window active");
        } else if (motion) {
          setComfort("Recipe activated — motion detected");
        } else {
          setEco("Recipe activated — no motion");
        }
      }

      // ── Wire up subscriptions ────────────────────────────

      // Reset runtime state
      ctx.state.delete("overrideMode");
      ctx.state.delete("cocoonMode");
      ctx.state.set("currentMode", "eco");

      // Subscribe to zone changes (motion)
      const unsubZone = ctx.eventBus.onType("zone.data.changed", (event) => {
        if (event.zoneId !== zoneId) return;
        onZoneChanged(
          (event.aggregatedData as { motion: boolean })?.motion ?? false,
        );
      });
      unsubs.push(unsubZone);

      // Subscribe to thermostat setpoint changes (manual override detection)
      const unsubSetpoint = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId !== thermostatId) return;
        if (event.alias !== "setpoint") return;
        onSetpointChanged(event.value);
      });
      unsubs.push(unsubSetpoint);

      // Subscribe to button actions (cocoon toggle)
      if (buttonIds.length > 0) {
        const unsubButton = ctx.eventBus.onType("equipment.data.changed", (event) => {
          if (!buttonIds.includes(event.equipmentId as string)) return;
          if (event.alias !== "action") return;
          onButtonAction();
        });
        unsubs.push(unsubButton);
      }

      // Periodic check (preheat transitions + cocoon night exit)
      if (needsPeriodicCheck()) {
        wasInPreheat = isInPreheatWindow();
        wasInNight = isInNightWindow();
        periodicCheckTimer = setInterval(() => {
          checkPeriodicTransitions();
        }, 60_000);
      }

      // Force consistent setpoint on activation
      syncOnStart();

      // ── Return instance ──────────────────────────────────

      return {
        stop() {
          cancelEcoTimer();
          if (periodicCheckTimer) {
            clearInterval(periodicCheckTimer);
            periodicCheckTimer = null;
          }
          for (const unsub of unsubs) {
            unsub();
          }
          unsubs.length = 0;
          overrideMode = false;
          lastSentSetpoint = null;
          setpointGraceUntil = 0;
          ctx.state.delete("overrideMode");
          ctx.state.delete("cocoonMode");
          ctx.state.delete("timerExpiresAt");
          ctx.state.delete("currentMode");
        },

        onAction(action: string, payload?: Record<string, unknown>): void {
          if (action !== "set_mode" || !payload?.mode) return;
          const mode = payload.mode as string;

          // Clear override if active — user is explicitly choosing a mode
          if (overrideMode) {
            clearOverrideMode();
          }

          switch (mode) {
            case "night":
              if (nightTemp !== null && currentMode !== "night") {
                setNight("Manual activation from UI");
              }
              break;
            case "cocoon":
              if (cocoonTemp !== null && currentMode !== "cocoon") {
                setCocoon("Manual activation from UI");
              }
              break;
            case "comfort":
              if (currentMode !== "comfort") {
                setComfort("Manual activation from UI");
              }
              break;
            case "eco":
              if (currentMode !== "eco") {
                setEco("Manual activation from UI");
              }
              break;
          }
        },
      };
    },
  };
}
