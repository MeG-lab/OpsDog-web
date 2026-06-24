export const deferTerminalConnection = (open: () => void): (() => void) => {
  const timeoutId = globalThis.setTimeout(open, 0);
  return () => globalThis.clearTimeout(timeoutId);
};
