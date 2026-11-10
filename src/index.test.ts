import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecipe } from "./index.js";

describe("createRecipe", () => {
  it("shows the mode on the thermostat's card, not on the cocoon buttons' (core spec 201)", () => {
    const action = createRecipe().actions?.find((a) => a.id === "set_mode");
    expect(action?.targets).toEqual(["thermostat"]);
  });

  it("offers cocoon and night only when their setpoint is set (core #1210)", () => {
    const options = createRecipe().actions?.find((a) => a.id === "set_mode")?.options ?? [];
    const required = Object.fromEntries(options.map((o) => [o.value, o.requiresParam]));
    expect(required).toEqual({
      eco: undefined,
      comfort: undefined,
      cocoon: "cocoonTemp",
      night: "nightTemp",
    });
  });
});

// A minimal ctx: what createInstance and set_mode touch.
function fakeCtx() {
  const state = new Map<string, unknown>();
  const handlers: { type: string; fn: (e: Record<string, unknown>) => void }[] = [];
  const ctx = {
    state: {
      get: (k: string) => state.get(k),
      set: (k: string, v: unknown) => void state.set(k, v),
      delete: (k: string) => void state.delete(k),
    },
    log: vi.fn(),
    dispatchOrder: vi.fn(async () => ({ success: true })),
    eventBus: {
      onType: (type: string, fn: (e: Record<string, unknown>) => void) => {
        handlers.push({ type, fn });
        return () => {};
      },
    },
    zoneAggregator: { getByZoneId: () => ({ motion: false }) },
    helpers: { parseDuration: () => 30 * 60_000, formatDuration: () => "30 min" },
  };
  const emit = (type: string, event: Record<string, unknown>) =>
    handlers.filter((h) => h.type === type).forEach((h) => h.fn(event));
  return { ctx, state, emit };
}

describe("set_mode for a mode that is not configured (core #1210)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const mode of ["cocoon", "night"]) {
    it(`ignores ${mode} without its setpoint and keeps a manual override`, () => {
      const { ctx, state, emit } = fakeCtx();
      const handle = createRecipe().createInstance(
        { zone: "z1", thermostat: "t1", comfortTemp: 21, ecoTemp: 17 },
        ctx as never,
      );
      // Past the 5 s echo grace, the user sets 23 °C by hand: override.
      vi.advanceTimersByTime(6000);
      emit("equipment.data.changed", { equipmentId: "t1", alias: "setpoint", value: 23 });
      expect(state.get("overrideMode")).toBe(true);
      ctx.dispatchOrder.mockClear();

      handle.onAction?.("set_mode", { mode });

      expect(state.get("overrideMode")).toBe(true);
      expect(state.get("currentMode")).toBe("eco");
      expect(ctx.dispatchOrder).not.toHaveBeenCalled();
      handle.stop();
    });
  }
});
