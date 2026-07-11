import { describe, expect, it } from "vitest";
import { deriveWorkflowModelSlotFieldPairs } from "../model-slot-save-validation.js";

describe("deriveWorkflowModelSlotFieldPairs", () => {
  it("pairs every declared xProvider/xModelId id by naming convention", () => {
    const pairs = deriveWorkflowModelSlotFieldPairs([
      { id: "executionProvider" },
      { id: "executionModelId" },
      { id: "planningProvider" },
      { id: "planningModelId" },
      { id: "planningFallbackProvider" },
      { id: "planningFallbackModelId" },
      { id: "validatorProvider" },
      { id: "validatorModelId" },
      { id: "validatorFallbackProvider" },
      { id: "validatorFallbackModelId" },
      { id: "workflowStepTimeoutMs" },
    ]);

    expect(pairs).toEqual(
      expect.arrayContaining([
        { providerField: "executionProvider", modelField: "executionModelId" },
        { providerField: "planningProvider", modelField: "planningModelId" },
        { providerField: "planningFallbackProvider", modelField: "planningFallbackModelId" },
        { providerField: "validatorProvider", modelField: "validatorModelId" },
        { providerField: "validatorFallbackProvider", modelField: "validatorFallbackModelId" },
      ]),
    );
    expect(pairs).toHaveLength(5);
  });

  it("skips a Provider id with no matching ModelId id declared", () => {
    const pairs = deriveWorkflowModelSlotFieldPairs([{ id: "executionProvider" }]);
    expect(pairs).toEqual([]);
  });

  it("returns an empty array for undefined/empty declarations", () => {
    expect(deriveWorkflowModelSlotFieldPairs(undefined)).toEqual([]);
    expect(deriveWorkflowModelSlotFieldPairs([])).toEqual([]);
  });
});
