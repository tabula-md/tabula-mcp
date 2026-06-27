export const extractCommentMarkers = (markdown) => {
  const comments = [];
  let offset = 0;
  const lines = String(markdown || "").split("\n");

  for (const [index, line] of lines.entries()) {
    const htmlComment = line.match(/<!--\s*tabula-comment\s*:?\s*(.*?)\s*-->/i);
    const calloutComment = line.match(/^\s*>\s*\[!comment\]\s*(.+?)\s*$/i);
    const text = (htmlComment?.[1] || calloutComment?.[1] || "").trim();

    if (text) {
      comments.push({
        id: `comment-${index + 1}-${comments.length + 1}`,
        line: index + 1,
        offset,
        text,
        marker: htmlComment ? "html-comment" : "comment-callout",
      });
    }

    offset += line.length + 1;
  }

  return comments;
};

export const formatCommentContextMessage = ({ title, source, sha256, comment }) =>
  [
    `Tabula.md comment from ${source || "document"} "${title || "Untitled Document"}".`,
    `Line: ${comment.line}`,
    sha256 ? `Hash: ${sha256}` : "",
    "",
    comment.text,
  ]
    .filter(Boolean)
    .join("\n");
