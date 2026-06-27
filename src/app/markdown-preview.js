const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeHref = (href) => {
  try {
    const url = new URL(href, "https://tabula.md");
    if (["http:", "https:", "mailto:"].includes(url.protocol)) {
      return href;
    }
  } catch {
    return "";
  }

  return "";
};

const renderInline = (value) => {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const safeUrl = safeHref(href.trim());
    if (!safeUrl) {
      return label;
    }

    return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  return html;
};

const flushParagraph = (blocks, paragraphLines) => {
  if (paragraphLines.length === 0) {
    return;
  }

  blocks.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
  paragraphLines.length = 0;
};

const flushList = (blocks, listItems) => {
  if (listItems.length === 0) {
    return;
  }

  blocks.push(`<ul>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
  listItems.length = 0;
};

export const renderMarkdownPreview = (markdown) => {
  const blocks = [];
  const paragraphLines = [];
  const listItems = [];
  const lines = String(markdown ?? "").split("\n");
  let codeFence = null;
  let codeLines = [];

  for (const line of lines) {
    const fenceMatch = line.match(/^```(\S*)\s*$/);
    if (fenceMatch) {
      if (codeFence) {
        blocks.push(
          `<pre><code${codeFence.language ? ` data-language="${escapeHtml(codeFence.language)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
        );
        codeFence = null;
        codeLines = [];
      } else {
        flushParagraph(blocks, paragraphLines);
        flushList(blocks, listItems);
        codeFence = {
          language: fenceMatch[1] || "",
        };
      }
      continue;
    }

    if (codeFence) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph(blocks, paragraphLines);
      flushList(blocks, listItems);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch?.[1] && headingMatch[2]) {
      flushParagraph(blocks, paragraphLines);
      flushList(blocks, listItems);
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInline(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.+)$/);
    if (quoteMatch?.[1]) {
      flushParagraph(blocks, paragraphLines);
      flushList(blocks, listItems);
      blocks.push(`<blockquote>${renderInline(quoteMatch[1])}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch?.[1]) {
      flushParagraph(blocks, paragraphLines);
      listItems.push(listMatch[1]);
      continue;
    }

    paragraphLines.push(line.trim());
  }

  flushParagraph(blocks, paragraphLines);
  flushList(blocks, listItems);
  if (codeFence) {
    blocks.push(
      `<pre><code${codeFence.language ? ` data-language="${escapeHtml(codeFence.language)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
    );
  }

  return blocks.length > 0 ? blocks.join("\n") : '<p class="empty-preview">No Markdown content</p>';
};
