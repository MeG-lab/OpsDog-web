import { Readable } from 'node:stream';

const jsonHeaders = (corsHeaders = {}) => ({
  'Content-Type': 'application/json; charset=utf-8',
  ...corsHeaders,
});

const sendJson = (res, statusCode, payload, corsHeaders = {}) => {
  res.writeHead(statusCode, jsonHeaders(corsHeaders));
  res.end(JSON.stringify(payload));
};

const safeDownloadFileName = (fileName) => encodeURIComponent(
  String(fileName || 'download').replace(/[\r\n"]/g, '_'),
);

const buildRouteError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const sendError = (res, error, corsHeaders) => {
  const statusCode = Number(error?.statusCode) || 500;
  sendJson(res, statusCode, {
    error: statusCode >= 500 ? 'SFTP request failed.' : error.message,
    details: { code: error?.code || 'SFTP_REQUEST_FAILED' },
  }, corsHeaders);
};

const readTextBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const readJsonBody = async (req) => {
  try {
    const text = await readTextBody(req);
    return text ? JSON.parse(text) : {};
  } catch {
    throw buildRouteError('SFTP_JSON_INVALID', 'SFTP request body must be valid JSON.');
  }
};

const requireBodyPath = (payload, fieldName = 'path') => {
  const value = String(payload?.[fieldName] ?? '').trim();
  if (!value) {
    throw buildRouteError('SFTP_PATH_REQUIRED', 'SFTP path is required.');
  }
  return value;
};

const requestHeaders = (req) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
};

const parseUploadForm = async (req) => {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    throw buildRouteError(
      'SFTP_UPLOAD_BODY_UNSUPPORTED',
      'SFTP upload requires multipart form data.',
      415,
    );
  }

  let form = null;
  try {
    const request = new Request('http://opsdog.local/sftp-upload', {
      method: req.method,
      headers: requestHeaders(req),
      body: req,
      duplex: 'half',
    });
    form = await request.formData();
  } catch {
    throw buildRouteError('SFTP_UPLOAD_FORM_INVALID', 'SFTP upload form data is invalid.');
  }

  const file = form.get('file');
  if (!file || typeof file.stream !== 'function') {
    throw buildRouteError('SFTP_UPLOAD_FILE_REQUIRED', 'SFTP upload file is required.');
  }
  const remotePath = String(form.get('path') ?? '').trim();
  if (!remotePath) {
    throw buildRouteError('SFTP_PATH_REQUIRED', 'SFTP path is required.');
  }

  const confirmText = String(form.get('confirmOverwrite') ?? '').trim().toLowerCase();
  const confirmOverwrite = ['1', 'true', 'yes', 'on'].includes(confirmText);
  return {
    remotePath,
    fileName: String(file.name || ''),
    stream: Readable.fromWeb(file.stream()),
    sizeBytes: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
    confirmOverwrite,
  };
};

const streamDownload = (req, res, transfer, corsHeaders) => {
  const encodedFileName = safeDownloadFileName(transfer.displayFileName);
  res.writeHead(200, {
    ...corsHeaders,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
  });
  req.once('close', () => {
    if (!res.writableEnded) transfer.stream.destroy?.();
  });
  transfer.stream.once('error', () => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: 'SFTP download failed.',
        details: { code: 'SFTP_DOWNLOAD_FAILED' },
      }, corsHeaders);
      return;
    }
    res.destroy();
  });
  transfer.stream.pipe(res);
};

export const handleSftpHttpRoute = async ({
  req,
  res,
  url,
  segments,
  sftpService,
  corsHeaders = {},
}) => {
  try {
    if (segments.length === 5
        && segments[0] === 'api'
        && segments[1] === 'remote'
        && segments[2] === 'profiles'
        && segments[4] === 'sftp-sessions'
        && req.method === 'POST') {
      sendJson(res, 200, await sftpService.openSession(decodeURIComponent(segments[3])), corsHeaders);
      return true;
    }

    if (segments.length === 4
        && segments[0] === 'api'
        && segments[1] === 'remote'
        && segments[2] === 'sftp-sessions') {
      const sessionId = decodeURIComponent(segments[3]);
      if (req.method === 'DELETE') {
        sftpService.closeSession(sessionId, 'operator_closed');
        sendJson(res, 200, { ok: true }, corsHeaders);
        return true;
      }
    }

    if (segments.length === 5
        && segments[0] === 'api'
        && segments[1] === 'remote'
        && segments[2] === 'sftp-sessions') {
      const sessionId = decodeURIComponent(segments[3]);
      const remotePath = url.searchParams.get('path') || '.';
      if (req.method === 'GET' && segments[4] === 'list') {
        sendJson(res, 200, await sftpService.list(sessionId, remotePath), corsHeaders);
        return true;
      }
      if (req.method === 'GET' && segments[4] === 'stat') {
        sendJson(res, 200, await sftpService.stat(sessionId, remotePath), corsHeaders);
        return true;
      }
      if (req.method === 'GET' && segments[4] === 'download') {
        streamDownload(req, res, await sftpService.download(sessionId, remotePath), corsHeaders);
        return true;
      }
      if (req.method === 'POST' && segments[4] === 'upload') {
        sendJson(res, 200, await sftpService.upload(sessionId, await parseUploadForm(req)), corsHeaders);
        return true;
      }
      if (req.method === 'POST' && segments[4] === 'mkdir') {
        const payload = await readJsonBody(req);
        sendJson(res, 200, await sftpService.mkdir(sessionId, requireBodyPath(payload)), corsHeaders);
        return true;
      }
      if (req.method === 'POST' && segments[4] === 'rename') {
        const payload = await readJsonBody(req);
        const fromPath = String(payload?.fromPath ?? '').trim();
        const toPath = String(payload?.toPath ?? '').trim();
        if (!fromPath || !toPath) {
          throw buildRouteError('SFTP_RENAME_PATHS_REQUIRED', 'SFTP rename source and target paths are required.');
        }
        sendJson(res, 200, await sftpService.rename(sessionId, fromPath, toPath), corsHeaders);
        return true;
      }
      if (req.method === 'DELETE' && segments[4] === 'entries') {
        const deletePath = String(url.searchParams.get('path') || '').trim();
        if (!deletePath) {
          throw buildRouteError('SFTP_PATH_REQUIRED', 'SFTP path is required.');
        }
        sendJson(res, 200, await sftpService.deleteFile(sessionId, deletePath), corsHeaders);
        return true;
      }
    }

    return false;
  } catch (error) {
    if (!res.writableEnded) sendError(res, error, corsHeaders);
    return true;
  }
};
