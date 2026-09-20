import { describe, expect, it } from "vitest";
import { buildTemplatesQuery, type TemplateListFilters } from "./template-query";

function filters(overrides: Partial<TemplateListFilters> = {}): TemplateListFilters {
  return { search: "", status: "", category: "", page: 1, pageSize: 20, ...overrides };
}

describe("buildTemplatesQuery", () => {
  it("always includes page and pageSize", () => {
    const params = new URLSearchParams(buildTemplatesQuery(filters({ page: 3, pageSize: 50 })));
    expect(params.get("page")).toBe("3");
    expect(params.get("pageSize")).toBe("50");
  });

  it("omits search, status and category when unset", () => {
    const params = new URLSearchParams(buildTemplatesQuery(filters()));
    expect(params.has("search")).toBe(false);
    expect(params.has("status")).toBe(false);
    expect(params.has("category")).toBe(false);
  });

  it("trims search and omits it when it is blank after trimming", () => {
    const trimmed = new URLSearchParams(buildTemplatesQuery(filters({ search: "  order  " })));
    expect(trimmed.get("search")).toBe("order");

    const blank = new URLSearchParams(buildTemplatesQuery(filters({ search: "   " })));
    expect(blank.has("search")).toBe(false);
  });

  it("includes status and category when set", () => {
    const params = new URLSearchParams(
      buildTemplatesQuery(filters({ status: "rejected", category: "marketing" })),
    );
    expect(params.get("status")).toBe("rejected");
    expect(params.get("category")).toBe("marketing");
  });
});
