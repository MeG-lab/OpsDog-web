export const createClientId = (prefix = 'id'): string => {
  const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUuid) return randomUuid();

  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${timestamp}-${randomPart}`;
};
