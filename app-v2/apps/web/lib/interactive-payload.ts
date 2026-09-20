/**
 * Maps the wire-level interactive payload (`packages/contracts/src/
 * messages.ts`'s `interactivePayloadSchema`) onto the provider port's shape
 * (`modules/whatsapp/domain/whatsapp-provider.interface.ts`'s
 * `InteractivePayload`).
 *
 * The trap: the contract's discriminant is `kind: "button"` (singular,
 * matching Meta's own `interactive.type` value for this message), while the
 * provider port's is `kind: "buttons"` (plural, matching the vendor
 * `buttons[]` field it carries). Same shape, different tag — mapped
 * explicitly below, never cast, so a real divergence between the two types
 * is a compile error here instead of a silent lie at the type boundary.
 */
import type { InteractivePayload as ContractInteractivePayload } from "@packages/contracts/src/messages";
import type { InteractivePayload as ProviderInteractivePayload } from "@modules/whatsapp/domain/whatsapp-provider.interface";

export function toProviderInteractive(
  bodyText: string,
  payload: ContractInteractivePayload,
): ProviderInteractivePayload {
  switch (payload.kind) {
    case "button":
      return { kind: "buttons", bodyText, buttons: payload.buttons };
    case "list":
      return {
        kind: "list",
        bodyText,
        buttonLabel: payload.buttonLabel,
        sections: payload.sections,
      };
  }
}
