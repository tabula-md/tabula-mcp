import { describe, expect, it } from "vitest";
import { renderMarkdownPreview } from "../../src/app/markdown-preview.js";

describe("Markdown preview rendering", () => {
  it("renders common Markdown blocks", () => {
    const html = renderMarkdownPreview("# Title\n\nBody with **bold** and `code`.\n\n- One\n- Two");

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>One</li><li>Two</li></ul>");
  });

  it("escapes raw HTML and code fences", () => {
    const html = renderMarkdownPreview("<script>alert(1)</script>\n\n```js\nconst x = '<tag>';\n```");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("data-language=\"js\"");
    expect(html).toContain("&lt;tag&gt;");
  });

  it("keeps safe links and strips unsafe link targets", () => {
    const html = renderMarkdownPreview("[Tabula](https://tabula.md) [bad](javascript:alert(1))");

    expect(html).toContain('<a href="https://tabula.md"');
    expect(html).toContain("bad");
    expect(html).not.toContain("javascript:");
  });
});
