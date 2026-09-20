import { describe, expect, it } from "vitest";
import { renderTemplateBody } from "./template-render";

describe("renderTemplateBody", () => {
  it("replaces placeholders positionally, 1-based", () => {
    expect(renderTemplateBody("Hi {{1}}, your order {{2}} shipped.", ["Amy", "#42"])).toBe(
      "Hi Amy, your order #42 shipped.",
    );
  });

  it("leaves an index with no parameter as the literal placeholder, never 'undefined'", () => {
    expect(renderTemplateBody("Hi {{1}}, code {{2}}.", ["Amy"])).toBe("Hi Amy, code {{2}}.");
  });

  it("does not re-expand a placeholder-looking string inside a parameter's own text", () => {
    expect(renderTemplateBody("Hi {{1}}, {{2}}", ["{{2}}", "world"])).toBe("Hi {{2}}, world");
  });

  it("returns bodyText unchanged when it has no placeholders", () => {
    expect(renderTemplateBody("Hello there.", [])).toBe("Hello there.");
  });

  it("handles a body with no parameters supplied at all", () => {
    expect(renderTemplateBody("Hi {{1}}!", [])).toBe("Hi {{1}}!");
  });
});
