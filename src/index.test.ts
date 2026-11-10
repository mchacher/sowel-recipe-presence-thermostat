import { describe, expect, it } from "vitest";
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
