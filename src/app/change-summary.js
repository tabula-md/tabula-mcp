const defaultMaxExcerptChars = 1200;

const commonPrefixLength = (left, right) => {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;
  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }
  return index;
};

const commonSuffixLength = (left, right, prefixLength) => {
  const maxLength = Math.min(left.length, right.length) - prefixLength;
  let index = 0;
  while (
    index < maxLength &&
    left[left.length - index - 1] === right[right.length - index - 1]
  ) {
    index += 1;
  }
  return index;
};

const truncateMiddle = (text, maxChars) => {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }

  const headLength = Math.max(0, Math.floor(maxChars / 2) - 18);
  const tailLength = Math.max(0, maxChars - headLength - 37);

  return {
    text: `${text.slice(0, headLength)}\n...[truncated]...\n${text.slice(-tailLength)}`,
    truncated: true,
  };
};

export const extractHeadingLabels = (markdown) => {
  const headings = [];
  const lines = String(markdown ?? "").split("\n");

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match?.[1] && match[2]) {
      headings.push({
        depth: match[1].length,
        text: match[2].trim(),
        line: index + 1,
        label: `${"#".repeat(match[1].length)} ${match[2].trim()}`,
      });
    }
  }

  return headings;
};

const labelSet = (headings) => new Set(headings.map((heading) => heading.label));

export const createMarkdownChangeSummary = (previousMarkdown, currentMarkdown, options = {}) => {
  const previous = String(previousMarkdown ?? "");
  const current = String(currentMarkdown ?? "");
  const maxExcerptChars = options.maxExcerptChars ?? defaultMaxExcerptChars;
  const prefixLength = commonPrefixLength(previous, current);
  const suffixLength = commonSuffixLength(previous, current, prefixLength);
  const previousEnd = previous.length - suffixLength;
  const currentEnd = current.length - suffixLength;
  const previousChanged = previous.slice(prefixLength, previousEnd);
  const currentChanged = current.slice(prefixLength, currentEnd);
  const previousExcerpt = truncateMiddle(previousChanged, maxExcerptChars);
  const currentExcerpt = truncateMiddle(currentChanged, maxExcerptChars);
  const previousHeadings = extractHeadingLabels(previous);
  const currentHeadings = extractHeadingLabels(current);
  const previousLabels = labelSet(previousHeadings);
  const currentLabels = labelSet(currentHeadings);

  return {
    changed: previous !== current,
    previousLength: previous.length,
    currentLength: current.length,
    changedRange: {
      previousStart: prefixLength,
      previousEnd,
      currentStart: prefixLength,
      currentEnd,
    },
    removedChars: previousChanged.length,
    addedChars: currentChanged.length,
    previousExcerpt: previousExcerpt.text,
    currentExcerpt: currentExcerpt.text,
    truncated: previousExcerpt.truncated || currentExcerpt.truncated,
    outline: {
      before: previousHeadings.map((heading) => heading.label),
      after: currentHeadings.map((heading) => heading.label),
      added: currentHeadings
        .filter((heading) => !previousLabels.has(heading.label))
        .map((heading) => heading.label),
      removed: previousHeadings
        .filter((heading) => !currentLabels.has(heading.label))
        .map((heading) => heading.label),
    },
  };
};

const formatList = (items) => (items.length > 0 ? items.join(", ") : "None");

export const formatDocumentChangeMessage = ({ title, documentId, baseSha256, summary }) => {
  const header = [
    `User edited Tabula.md document "${title || "Untitled Document"}".`,
    `Document id: ${documentId || "unknown"}`,
    `Base saved hash: ${baseSha256 || "unknown"}`,
    `Length: ${summary.previousLength} -> ${summary.currentLength} chars`,
    `Changed range: previous ${summary.changedRange.previousStart}-${summary.changedRange.previousEnd}, current ${summary.changedRange.currentStart}-${summary.changedRange.currentEnd}`,
    `Outline added: ${formatList(summary.outline.added)}`,
    `Outline removed: ${formatList(summary.outline.removed)}`,
  ];

  const excerpts = [];
  if (summary.previousExcerpt) {
    excerpts.push(`Previous changed excerpt:\n\n\`\`\`markdown\n${summary.previousExcerpt}\n\`\`\``);
  }
  if (summary.currentExcerpt) {
    excerpts.push(`Current changed excerpt:\n\n\`\`\`markdown\n${summary.currentExcerpt}\n\`\`\``);
  }
  if (summary.truncated) {
    excerpts.push("Excerpt output was truncated; ask for a narrower selection if exact surrounding text is needed.");
  }

  return [...header, ...excerpts].join("\n\n");
};
