export function trimTrailingCharacter(value: string, character: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === character) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function trimSlashes(value: string): string {
  return trimTrailingCharacter(value.replace(/^\/+/u, ''), '/');
}
