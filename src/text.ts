export type TextPatch = {
  from: number;
  to: number;
  insert: string;
};

export type MarkdownHeading = {
  depth: number;
  text: string;
  line: number;
  offset: number;
};

const comparePatchesDescending = (first: TextPatch, second: TextPatch) =>
  second.from - first.from || second.to - first.to;

const comparePatchesAscending = (first: TextPatch, second: TextPatch) =>
  first.from - second.from || first.to - second.to;

export const normalizeTextPatches = (patches: readonly TextPatch[]) =>
  [...patches].sort(comparePatchesAscending);

export const areTextPatchesApplicable = (text: string, patches: readonly TextPatch[]) => {
  let previousTo = 0;

  for (const patch of normalizeTextPatches(patches)) {
    if (
      !Number.isInteger(patch.from) ||
      !Number.isInteger(patch.to) ||
      patch.from < 0 ||
      patch.to < patch.from ||
      patch.to > text.length ||
      patch.from < previousTo
    ) {
      return false;
    }

    previousTo = patch.to;
  }

  return true;
};

export const applyTextPatchesToString = (text: string, patches: readonly TextPatch[]) => {
  if (!areTextPatchesApplicable(text, patches)) {
    return null;
  }

  return [...patches]
    .sort(comparePatchesDescending)
    .reduce(
      (currentText, patch) =>
        `${currentText.slice(0, patch.from)}${patch.insert}${currentText.slice(patch.to)}`,
      text,
    );
};

export const getMarkdownOutline = (markdown: string): MarkdownHeading[] => {
  const headings: MarkdownHeading[] = [];
  let offset = 0;

  markdown.split("\n").forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    const marker = match?.[1];
    const title = match?.[2];
    if (marker && title) {
      headings.push({
        depth: marker.length,
        text: title.trim(),
        line: index + 1,
        offset,
      });
    }

    offset += line.length + 1;
  });

  return headings;
};
