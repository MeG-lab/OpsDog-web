const MAX_COMMANDS_PER_REQUEST = 20;
const MAX_COMMAND_BYTES_PER_REQUEST = 64 * 1024;

const buildAiRemoteError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const normalizeSessionId = (sessionId) => {
  const normalized = String(sessionId || '').trim();
  if (!normalized) {
    throw buildAiRemoteError('AI_REMOTE_SESSION_REQUIRED', 'AI remote execution requires a sessionId.');
  }
  return normalized;
};

const normalizeCommands = (commands) => {
  const list = Array.isArray(commands) ? commands : [commands];
  const normalized = list
    .map((command) => String(command ?? ''))
    .map((command) => command.replace(/\0/g, ''))
    .filter((command) => command.trim().length > 0);

  if (normalized.length === 0) {
    throw buildAiRemoteError('AI_REMOTE_COMMAND_REQUIRED', 'AI remote execution requires at least one command.');
  }
  if (normalized.length > MAX_COMMANDS_PER_REQUEST) {
    throw buildAiRemoteError('AI_REMOTE_COMMAND_LIMIT', `AI remote execution supports at most ${MAX_COMMANDS_PER_REQUEST} commands per request.`);
  }

  const writtenBytes = normalized.reduce((total, command) => total + Buffer.byteLength(command, 'utf8') + 1, 0);
  if (writtenBytes > MAX_COMMAND_BYTES_PER_REQUEST) {
    throw buildAiRemoteError('AI_REMOTE_COMMAND_TOO_LARGE', 'AI remote command payload is too large.');
  }

  return normalized;
};

const appendEnterIfNeeded = (command) => (
  /[\r\n]$/.test(command) ? command : `${command}\r`
);

export const executeAiRemoteCommands = ({
  terminalService,
  sessionId,
  commands,
  now = () => new Date().toISOString(),
}) => {
  if (!terminalService || typeof terminalService.write !== 'function') {
    throw buildAiRemoteError('AI_REMOTE_TERMINAL_UNAVAILABLE', 'AI remote terminal service is unavailable.', 503);
  }

  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedCommands = normalizeCommands(commands);
  let writtenBytes = 0;

  for (const command of normalizedCommands) {
    const data = appendEnterIfNeeded(command);
    terminalService.write(normalizedSessionId, data);
    writtenBytes += Buffer.byteLength(data, 'utf8');
  }

  return {
    status: 'executed',
    sessionId: normalizedSessionId,
    commandCount: normalizedCommands.length,
    writtenBytes,
    executedAt: now(),
  };
};

export const handleAiRemoteRoute = async ({
  req,
  segments,
  readJsonBody,
  sendJson,
  terminalService,
}) => {
  if (
    segments.length === 4
    && segments[0] === 'api'
    && segments[1] === 'remote'
    && segments[2] === 'ai'
    && segments[3] === 'execute'
    && req.method === 'POST'
  ) {
    const payload = await readJsonBody(req);
    const result = executeAiRemoteCommands({
      terminalService,
      sessionId: payload.sessionId,
      commands: Array.isArray(payload.commands) ? payload.commands : payload.command,
    });
    sendJson(200, result);
    return true;
  }

  return false;
};
