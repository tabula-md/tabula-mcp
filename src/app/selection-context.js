const defaultMaxSelectionChars = 1600;

const truncateMiddle = (text, maxChars) => {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }

  const headLength = Math.max(0, Math.floor(maxChars / 2) - 20);
  const tailLength = Math.max(0, maxChars - headLength - 43);

  return {
    text: `${text.slice(0, headLength)}\n...[truncated selection]...\n${text.slice(-tailLength)}`,
    truncated: true,
  };
};

export const createSelectionContext = (selectedText, options = {}) => {
  const text = String(selectedText ?? "").trim();
  const maxChars = options.maxChars ?? defaultMaxSelectionChars;
  const excerpt = truncateMiddle(text, maxChars);

  return {
    text: excerpt.text,
    originalLength: text.length,
    excerptLength: excerpt.text.length,
    truncated: excerpt.truncated,
  };
};

export const formatSelectionContextMessage = ({ source, sha256, selection }) => {
  const header = [
    `Selected Tabula.md text from ${source} at ${sha256 || "unknown"}.`,
    selection.truncated
      ? `Selection excerpt: ${selection.excerptLength} of ${selection.originalLength} chars`
      : `Selection length: ${selection.originalLength} chars`,
  ];

  const footer = selection.truncated
    ? ["Selection output was truncated; ask for a narrower selection if exact text is needed."]
    : [];

  return [...header, `\`\`\`markdown\n${selection.text}\n\`\`\``, ...footer].join("\n\n");
};
