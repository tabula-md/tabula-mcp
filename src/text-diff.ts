const lineAtOffset = (content: string, offset: number) =>
  content.slice(0, Math.max(0, offset)).split("\n").length;

export type ExactTextChange = {
  before: string;
  after: string;
  offset: number;
  oldText: string;
  newText: string;
};

const countChangedLines = (text: string) => text.split("\n").length;

const renderHunk = (change: ExactTextChange, contextLines: number) => {
  const oldLines = change.before.split("\n");
  const newLines = change.after.split("\n");
  const firstLine = lineAtOffset(change.before, change.offset);
  const oldChangedLines = countChangedLines(change.oldText);
  const newChangedLines = countChangedLines(change.newText);
  const contextStart = Math.max(1, firstLine - contextLines);
  const oldChangedEnd = firstLine + oldChangedLines - 1;
  const newChangedEnd = firstLine + newChangedLines - 1;
  const oldContextEnd = Math.min(oldLines.length, oldChangedEnd + contextLines);
  const newContextEnd = Math.min(newLines.length, newChangedEnd + contextLines);
  const oldCount = oldContextEnd - contextStart + 1;
  const newCount = newContextEnd - contextStart + 1;
  const beforeContext = oldLines.slice(contextStart - 1, firstLine - 1).map((line) => ` ${line}`);
  const removed = oldLines.slice(firstLine - 1, oldChangedEnd).map((line) => `-${line}`);
  const added = newLines.slice(firstLine - 1, newChangedEnd).map((line) => `+${line}`);
  const afterContext = newLines.slice(newChangedEnd, newContextEnd).map((line) => ` ${line}`);

  return [
    `@@ -${contextStart},${oldCount} +${contextStart},${newCount} @@`,
    ...beforeContext,
    ...removed,
    ...added,
    ...afterContext,
  ].join("\n");
};

export const renderExactTextDiff = ({
  path,
  changes,
  contextLines = 3,
  maxCharacters = 12_000,
}: {
  path: string;
  changes: readonly ExactTextChange[];
  contextLines?: number;
  maxCharacters?: number;
}) => {
  const changed = changes.filter((change) => change.before !== change.after);
  if (changed.length === 0) return { diff: "", diffTruncated: false };

  const rendered = [
    `--- a/${path}`,
    `+++ b/${path}`,
    ...[...changed]
      .sort((left, right) => lineAtOffset(left.before, left.offset) - lineAtOffset(right.before, right.offset))
      .map((change) => renderHunk(change, contextLines)),
  ].join("\n");
  if (rendered.length <= maxCharacters) return { diff: rendered, diffTruncated: false };

  const suffix = "\n... diff truncated";
  return {
    diff: `${rendered.slice(0, Math.max(0, maxCharacters - suffix.length))}${suffix}`,
    diffTruncated: true,
  };
};
