export const hasOddBackslashRun = (value: string, index: number): boolean => {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) count++;
  return count % 2 === 1;
};
