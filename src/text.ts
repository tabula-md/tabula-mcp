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

type MarkdownFence = {
  character: string;
  length: number;
};

const getOpeningMarkdownFence = (line: string): MarkdownFence | null => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const marker = match?.[1];
  const info = match?.[2];
  const character = marker?.[0];
  if (
    !marker
    || typeof info === "undefined"
    || !character
    || (character === "`" && info.includes("`"))
  ) {
    return null;
  }

  return {
    character,
    length: marker.length,
  };
};

const closesMarkdownFence = (line: string, fence: MarkdownFence) => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/);
  const marker = match?.[1];
  return Boolean(
    marker
      && marker[0] === fence.character
      && marker.length >= fence.length,
  );
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
  let openFence: MarkdownFence | null = null;
  let offset = 0;

  markdown.split("\n").forEach((line, index) => {
    const sourceLine = line.endsWith("\r") ? line.slice(0, -1) : line;

    if (openFence) {
      if (closesMarkdownFence(sourceLine, openFence)) {
        openFence = null;
      }
    } else {
      openFence = getOpeningMarkdownFence(sourceLine);
      if (!openFence) {
        const match = sourceLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
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
      }
    }

    offset += line.length + 1;
  });

  return headings;
};
