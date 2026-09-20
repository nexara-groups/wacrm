import { describe, expect, it } from "vitest";
import { toProviderInteractive } from "./interactive-payload";
import type { InteractivePayload as ContractInteractivePayload } from "@packages/contracts/src/messages";

describe("toProviderInteractive", () => {
  it("maps the contract's 'button' (singular) discriminant to the provider's 'buttons' (plural)", () => {
    const payload: ContractInteractivePayload = {
      kind: "button",
      buttons: [{ id: "yes", title: "Yes" }, { id: "no", title: "No" }],
    };

    expect(toProviderInteractive("Pick one", payload)).toEqual({
      kind: "buttons",
      bodyText: "Pick one",
      buttons: [{ id: "yes", title: "Yes" }, { id: "no", title: "No" }],
    });
  });

  it("carries buttonLabel, sections and bodyText through for a 'list' payload", () => {
    const payload: ContractInteractivePayload = {
      kind: "list",
      buttonLabel: "Choose",
      sections: [{ title: "Options", rows: [{ id: "a", title: "A" }] }],
    };

    expect(toProviderInteractive("Pick a section", payload)).toEqual({
      kind: "list",
      bodyText: "Pick a section",
      buttonLabel: "Choose",
      sections: [{ title: "Options", rows: [{ id: "a", title: "A" }] }],
    });
  });
});
