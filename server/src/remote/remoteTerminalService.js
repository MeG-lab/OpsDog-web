const buildRemoteTerminalError = (code, message, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const createRemoteTerminalService = ({
  profileService,
  sshTerminalService,
  telnetTerminalService,
}) => {
  const tokenProtocols = new Map();
  const sessionProtocols = new Map();

  const serviceForProtocol = (protocol) => {
    if (protocol === 'telnet') return telnetTerminalService;
    return sshTerminalService;
  };

  const resolveProfileProtocol = (profileId) => {
    const profile = profileService.getProfile(profileId);
    if (!profile) {
      throw buildRemoteTerminalError('REMOTE_PROFILE_INVALID', 'Remote terminal profile was not found.', 400);
    }
    return profile.protocol === 'telnet' ? 'telnet' : 'ssh';
  };

  const issueTerminalToken = async (profileId, dimensions = {}) => {
    const protocol = resolveProfileProtocol(profileId);
    const response = await serviceForProtocol(protocol).issueTerminalToken(profileId, dimensions);
    if (response?.status === 'ready' && response.token) {
      tokenProtocols.set(response.token, protocol);
    }
    return response;
  };

  const openTerminal = async (token) => {
    const protocol = tokenProtocols.get(token);
    tokenProtocols.delete(token);
    if (!protocol) {
      throw buildRemoteTerminalError('TERMINAL_TOKEN_INVALID', 'Terminal connection token is invalid or expired.', 401);
    }
    const terminal = await serviceForProtocol(protocol).openTerminal(token);
    sessionProtocols.set(terminal.sessionId, protocol);
    return terminal;
  };

  const requireSessionService = (sessionId) => {
    const protocol = sessionProtocols.get(sessionId);
    if (!protocol) {
      throw buildRemoteTerminalError('TERMINAL_SESSION_CLOSED', 'Terminal session is no longer active.', 410);
    }
    return serviceForProtocol(protocol);
  };

  const close = (sessionId, reason = 'operator_closed') => {
    const protocol = sessionProtocols.get(sessionId);
    if (!protocol) return;
    sessionProtocols.delete(sessionId);
    serviceForProtocol(protocol).close(sessionId, reason);
  };

  const closeAll = (reason = 'server_stopped') => {
    sessionProtocols.clear();
    sshTerminalService.closeAll(reason);
    telnetTerminalService.closeAll(reason);
  };

  return {
    issueTerminalToken,
    openTerminal,
    write(sessionId, data) {
      requireSessionService(sessionId).write(sessionId, data);
    },
    resize(sessionId, dimensions) {
      requireSessionService(sessionId).resize(sessionId, dimensions);
    },
    close,
    closeAll,
  };
};
