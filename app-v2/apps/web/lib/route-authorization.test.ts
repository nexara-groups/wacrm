import { describe, expect, it } from "vitest";
import { ROLES, type Role } from "@nexara/core/rbac";
import {
  ACTION_MINIMUM_ROLE,
  forbiddenMessageFor,
  isAuthorizedForAction,
  minimumRoleFor,
  type TenantAction,
} from "./route-authorization";

const ACTIONS = Object.keys(ACTION_MINIMUM_ROLE) as TenantAction[];

describe("route authorization table", () => {
  it("lets every role do exactly the actions at or above its rank, and no others", () => {
    // The whole matrix, spelled out rather than derived, so a change to the
    // table shows up here as a diff someone has to justify.
    const expected: Record<Role, TenantAction[]> = {
      member: ["contacts:write", "messages:send", "media:upload", "conversations:mark-read"],
      manager: [
        "contacts:write", "messages:send", "media:upload", "conversations:mark-read",
        "conversations:assign", "broadcasts:write", "broadcasts:control", "broadcasts:preview",
      ],
      admin: [
        "contacts:write", "messages:send", "media:upload", "conversations:mark-read",
        "conversations:assign", "broadcasts:write", "broadcasts:control", "broadcasts:preview",
        "seats:invite", "invitations:revoke", "members:remove",
      ],
      owner: ACTIONS,
    };

    for (const role of ROLES) {
      const allowed = ACTIONS.filter((action) => isAuthorizedForAction(role, action));
      expect(allowed.sort(), role).toEqual([...expected[role]].sort());
    }
  });

  it("never lets a member invite, remove a teammate, or connect a number", () => {
    // Stated separately from the matrix because these are the three that
    // matter most: seats cost money, removals lock people out, and the
    // WhatsApp token repoints every message the account sends.
    for (const action of ["seats:invite", "members:remove", "whatsapp:connect"] as const) {
      expect(isAuthorizedForAction("member", action), action).toBe(false);
    }
  });

  it("reserves connecting a WhatsApp number to the owner alone", () => {
    expect(minimumRoleFor("whatsapp:connect")).toBe("owner");
    for (const role of ["member", "manager", "admin"] as const) {
      expect(isAuthorizedForAction(role, "whatsapp:connect"), role).toBe(false);
    }
    expect(isAuthorizedForAction("owner", "whatsapp:connect")).toBe(true);
  });

  it("lets an owner do everything in the table", () => {
    for (const action of ACTIONS) expect(isAuthorizedForAction("owner", action), action).toBe(true);
  });

  it("tells the caller who to ask instead of just refusing", () => {
    // A refusal that withholds this becomes a support ticket.
    expect(forbiddenMessageFor("whatsapp:connect")).toContain("account owner");
    expect(forbiddenMessageFor("seats:invite")).toContain("admin");
    expect(forbiddenMessageFor("broadcasts:write")).toContain("manager");
  });

  it("names a minimum role that is a real role for every action", () => {
    for (const action of ACTIONS) expect(ROLES).toContain(ACTION_MINIMUM_ROLE[action]);
  });
});
