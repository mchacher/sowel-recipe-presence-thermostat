import { describe, expect, it } from "vitest";
import { createRecipe } from "./index.js";

describe("createRecipe", () => {
  it("shows the mode on the thermostat's card, not on the cocoon buttons' (core spec 201)", () => {
    const action = createRecipe().actions?.find((a) => a.id === "set_mode");
    expect(action?.targets).toEqual(["thermostat"]);
  });
});
