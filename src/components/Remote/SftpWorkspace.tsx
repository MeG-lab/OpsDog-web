import React from 'react';
import {
  ChevronUp,
  Database,
  Download,
  FileArchive,
  FileBox,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideoCamera,
  Folder,
  Info,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  createSftpDirectory,
  deleteSftpFile,
  getSftpDownloadUrl,
  listSftpEntries,
  renameSftpEntry,
  statSftpEntry,
  uploadSftpFile,
} from '../../services/runtime';
import type { SftpDirectoryEntry } from '../../services/runtime';

type SftpWorkspaceProps = {
  profileLabel: string;
  targetLabel: string;
  sessionId: string;
  onClose(): void;
};

type PendingMutation = {
  title: string;
  summary: string;
  run(): Promise<unknown>;
};

type SftpEntryIcon = {
  Icon: React.ComponentType<{ size?: number }>;
  tone: string;
  badge: string;
};

const entryKindLabel: Record<SftpDirectoryEntry['kind'], string> = {
  directory: '目录',
  file: '文件',
  other: '其他',
};

const formatSize = (size: number | null): string => {
  if (size === null) return '-';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

const formatModifiedAt = (value: string | null): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const getExtension = (name: string) => {
  const lastSegment = name.split('/').pop() || name;
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
};

const getSftpEntryIcon = (entry: SftpDirectoryEntry): SftpEntryIcon => {
  if (entry.kind === 'directory') return { Icon: Folder, tone: 'folder', badge: 'DIR' };
  if (entry.kind !== 'file') return { Icon: FileBox, tone: 'binary', badge: 'BIN' };

  const extension = getExtension(entry.name);
  const badge = extension ? extension.slice(0, 4).toUpperCase() : 'FILE';

  if (['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'ps1', 'php', 'rb', 'css', 'html', 'xml', 'vue', 'sql'].includes(extension)) {
    return { Icon: FileCode, tone: 'code', badge };
  }
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'log'].includes(extension)) {
    return { Icon: FileType, tone: 'text', badge };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'].includes(extension)) {
    return { Icon: FileImage, tone: 'image', badge };
  }
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'xz', 'bz2'].includes(extension)) {
    return { Icon: FileArchive, tone: 'archive', badge };
  }
  if (['xls', 'xlsx', 'csv', 'tsv'].includes(extension)) {
    return { Icon: FileSpreadsheet, tone: 'data', badge };
  }
  if (['db', 'sqlite', 'sqlite3', 'dump'].includes(extension)) {
    return { Icon: Database, tone: 'data', badge };
  }
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(extension)) {
    return { Icon: FileMusic, tone: 'media', badge };
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(extension)) {
    return { Icon: FileVideoCamera, tone: 'media', badge };
  }
  if (['txt', 'md', 'rst', 'doc', 'docx', 'pdf'].includes(extension)) {
    return { Icon: FileText, tone: 'text', badge };
  }
  return { Icon: FileText, tone: 'default', badge };
};

const getParentPath = (remotePath: string): string => {
  const value = (remotePath || '.').trim();
  if (value === '.' || value === '/' || value === '') return '.';
  const trimmed = value.replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '.';
  const absolute = trimmed.startsWith('/');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length <= 1) return absolute ? '/' : '.';
  const parent = parts.slice(0, -1).join('/');
  return absolute ? `/${parent}` : parent || '.';
};

const joinRemotePath = (basePath: string, name: string): string => {
  const cleanedName = name.trim().replace(/^\/+/, '');
  const cleanedBase = (basePath || '.').trim();
  if (!cleanedName) return cleanedBase || '.';
  if (cleanedBase === '.' || cleanedBase === '') return cleanedName;
  if (cleanedBase === '/') return `/${cleanedName}`;
  return `${cleanedBase.replace(/\/+$/, '')}/${cleanedName}`;
};

const sortEntries = (entries: SftpDirectoryEntry[]) => [...entries]
  .filter((entry) => entry.name !== '.' && entry.name !== '..')
  .sort((left, right) => {
    if (left.kind === 'directory' && right.kind !== 'directory') return -1;
    if (left.kind !== 'directory' && right.kind === 'directory') return 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });

const SftpWorkspace: React.FC<SftpWorkspaceProps> = ({
  profileLabel,
  targetLabel,
  sessionId,
  onClose,
}) => {
  const requestSeq = React.useRef(0);
  const [currentPath, setCurrentPath] = React.useState('.');
  const [pathInput, setPathInput] = React.useState('.');
  const [entries, setEntries] = React.useState<SftpDirectoryEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = React.useState<SftpDirectoryEntry | null>(null);
  const [selectedStat, setSelectedStat] = React.useState<SftpDirectoryEntry | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [statLoading, setStatLoading] = React.useState(false);
  const [mutationBusy, setMutationBusy] = React.useState(false);
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [uploadPath, setUploadPath] = React.useState('');
  const [confirmOverwrite, setConfirmOverwrite] = React.useState(false);
  const [mkdirPath, setMkdirPath] = React.useState('');
  const [renameFromPath, setRenameFromPath] = React.useState('');
  const [renameToPath, setRenameToPath] = React.useState('');
  const [deletePath, setDeletePath] = React.useState('');
  const [pendingMutation, setPendingMutation] = React.useState<PendingMutation | null>(null);
  const [error, setError] = React.useState('');

  const loadPath = React.useCallback(async (nextPath: string) => {
    const sequence = requestSeq.current + 1;
    requestSeq.current = sequence;
    setLoading(true);
    setError('');
    try {
      const result = await listSftpEntries(sessionId, nextPath || '.');
      if (requestSeq.current !== sequence) return;
      setCurrentPath(result.path);
      setPathInput(result.path);
      setEntries(sortEntries(result.entries));
      setSelectedEntry(null);
      setSelectedStat(null);
    } catch (loadError) {
      if (requestSeq.current !== sequence) return;
      setError(loadError instanceof Error ? loadError.message : 'SFTP 目录读取失败');
    } finally {
      if (requestSeq.current === sequence) setLoading(false);
    }
  }, [sessionId]);

  React.useEffect(() => {
    void loadPath('.');
    return () => {
      requestSeq.current += 1;
    };
  }, [loadPath]);

  const inspectEntry = async (entry: SftpDirectoryEntry) => {
    setSelectedEntry(entry);
    setSelectedStat(null);
    setStatLoading(true);
    setError('');
    try {
      const result = await statSftpEntry(sessionId, entry.path);
      setSelectedStat(result.entry);
    } catch (inspectError) {
      setError(inspectError instanceof Error ? inspectError.message : 'SFTP 属性读取失败');
    } finally {
      setStatLoading(false);
    }
  };

  const useSelectedForMutation = () => {
    if (!selectedEntry) return;
    setRenameFromPath(selectedEntry.path);
    setRenameToPath(selectedEntry.path);
    if (selectedEntry.kind === 'file') setDeletePath(selectedEntry.path);
  };

  const refreshAfterMutation = async () => {
    await loadPath(currentPath);
  };

  const confirmUpload = () => {
    if (!uploadFile) {
      setError('请选择要上传的文件');
      return;
    }
    const remotePath = (uploadPath || joinRemotePath(currentPath, uploadFile.name)).trim();
    if (!remotePath) {
      setError('请输入上传目标路径');
      return;
    }
    setError('');
    setPendingMutation({
      title: '上传文件',
      summary: `${uploadFile.name} -> ${remotePath}${confirmOverwrite ? '，覆盖已有文件' : '，不覆盖已有文件'}`,
      run: () => uploadSftpFile(sessionId, { remotePath, file: uploadFile, confirmOverwrite }),
    });
  };

  const confirmMkdir = () => {
    const remotePath = mkdirPath.trim();
    if (!remotePath) {
      setError('请输入新建目录路径');
      return;
    }
    setError('');
    setPendingMutation({
      title: '新建目录',
      summary: remotePath,
      run: () => createSftpDirectory(sessionId, remotePath),
    });
  };

  const confirmRename = () => {
    const fromPath = renameFromPath.trim();
    const toPath = renameToPath.trim();
    if (!fromPath || !toPath) {
      setError('请输入重命名来源和目标路径');
      return;
    }
    setError('');
    setPendingMutation({
      title: '重命名',
      summary: `${fromPath} -> ${toPath}`,
      run: () => renameSftpEntry(sessionId, fromPath, toPath),
    });
  };

  const confirmDelete = () => {
    const remotePath = deletePath.trim();
    if (!remotePath) {
      setError('请输入要删除的文件路径');
      return;
    }
    const selectedDirectory = selectedEntry?.path === remotePath && selectedEntry.kind === 'directory';
    if (selectedDirectory) {
      setError('P6 第一版仅支持删除文件，不支持目录删除');
      return;
    }
    setError('');
    setPendingMutation({
      title: '删除文件',
      summary: remotePath,
      run: () => deleteSftpFile(sessionId, remotePath),
    });
  };

  const runPendingMutation = async () => {
    if (!pendingMutation) return;
    setMutationBusy(true);
    setError('');
    try {
      await pendingMutation.run();
      setPendingMutation(null);
      setUploadFile(null);
      await refreshAfterMutation();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'SFTP 操作失败');
    } finally {
      setMutationBusy(false);
    }
  };

  const closeWorkspace = () => {
    onClose();
  };

  return (
    <div className="remote-sftp-browser">
      <header className="remote-sftp-head">
        <div className="remote-sftp-identity">
          <strong title={targetLabel}>{profileLabel} (SFTP)</strong>
        </div>
        <span className="remote-sftp-badge">SFTP 文件管理</span>
        <button
          type="button"
          className="remote-terminal-icon-btn"
          onClick={closeWorkspace}
          aria-label="关闭 SFTP 窗口"
          title="关闭 SFTP 窗口"
        >
          <X size={15} />
        </button>
      </header>

      <div className="remote-sftp-toolbar">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void loadPath(getParentPath(currentPath))}
          disabled={loading}
        >
          <ChevronUp size={15} />
          上级
        </button>
        <form
          className="remote-sftp-path"
          onSubmit={(event) => {
            event.preventDefault();
            void loadPath(pathInput);
          }}
        >
          <input
            className="input"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            aria-label="SFTP 路径"
          />
          <button type="submit" className="btn btn-primary remote-sftp-open-btn" disabled={loading}>
            打开
          </button>
        </form>
        <button type="button" className="btn btn-ghost" onClick={() => void loadPath(currentPath)} disabled={loading}>
          <RefreshCw size={15} />
          刷新
        </button>
        <button type="button" className="btn btn-ghost" onClick={useSelectedForMutation} disabled={!selectedEntry}>
          <Info size={15} />
          使用选中项
        </button>
      </div>

      <main className="remote-sftp-main">
        <section className="remote-sftp-list" aria-busy={loading}>
          <div className="remote-sftp-row remote-sftp-row-head">
            <span>名称</span>
            <span>类型</span>
            <span className="remote-sftp-cell-size">大小</span>
            <span className="remote-sftp-cell-date">修改时间</span>
            <span>操作</span>
          </div>
          {loading ? <div className="remote-sftp-empty">正在读取目录...</div> : null}
          {!loading && entries.length === 0 ? <div className="remote-sftp-empty">当前目录没有可显示条目。</div> : null}
          {!loading ? entries.map((entry) => {
            const icon = getSftpEntryIcon(entry);
            const EntryIcon = icon.Icon;
            return (
              <div
                key={entry.path}
                className={`remote-sftp-row${selectedEntry?.path === entry.path ? ' is-selected' : ''}`}
                onClick={() => setSelectedEntry(entry)}
                onDoubleClick={() => {
                  if (entry.kind === 'directory') void loadPath(entry.path);
                }}
              >
                <span className="remote-sftp-name">
                  <span className={`remote-sftp-file-icon ${icon.tone}`} aria-hidden="true">
                    <EntryIcon size={15} />
                    <small>{icon.badge}</small>
                  </span>
                  <span className="remote-sftp-entry-label">{entry.name}</span>
                </span>
                <span>{entryKindLabel[entry.kind]}</span>
                <span className="remote-sftp-cell-size">{formatSize(entry.size)}</span>
                <span className="remote-sftp-cell-date">{formatModifiedAt(entry.modifiedAt)}</span>
                <span className="remote-sftp-actions">
                  {entry.kind === 'directory' ? (
                    <button type="button" className="btn btn-ghost remote-sftp-open-btn" onClick={(event) => {
                      event.stopPropagation();
                      void loadPath(entry.path);
                    }}>
                      打开
                    </button>
                  ) : (
                    <a
                      className="btn btn-ghost"
                      href={getSftpDownloadUrl(sessionId, entry.path)}
                      download={entry.name}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Download size={14} />
                      下载
                    </a>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={(event) => {
                    event.stopPropagation();
                    void inspectEntry(entry);
                  }}>
                    <Info size={14} />
                    属性
                  </button>
                  {entry.kind === 'file' ? (
                    <button type="button" className="btn btn-ghost danger" onClick={(event) => {
                      event.stopPropagation();
                      setSelectedEntry(entry);
                      setDeletePath(entry.path);
                      setPendingMutation({
                        title: '删除文件',
                        summary: entry.path,
                        run: () => deleteSftpFile(sessionId, entry.path),
                      });
                    }}>
                      <Trash2 size={14} />
                      删除
                    </button>
                  ) : null}
                </span>
              </div>
            );
          }) : null}
        </section>

        <aside className="remote-sftp-detail">
          <strong>条目属性</strong>
          {statLoading ? <p>正在读取属性...</p> : null}
          {!statLoading && !selectedEntry ? <p>选择一个条目查看只读元数据。</p> : null}
          {!statLoading && selectedEntry ? (
            <dl>
              <dt>名称</dt>
              <dd>{(selectedStat || selectedEntry).name}</dd>
              <dt>路径</dt>
              <dd>{(selectedStat || selectedEntry).path}</dd>
              <dt>类型</dt>
              <dd>{entryKindLabel[(selectedStat || selectedEntry).kind]}</dd>
              <dt>大小</dt>
              <dd>{formatSize((selectedStat || selectedEntry).size)}</dd>
              <dt>修改时间</dt>
              <dd>{formatModifiedAt((selectedStat || selectedEntry).modifiedAt)}</dd>
              <dt>权限位</dt>
              <dd>{(selectedStat || selectedEntry).mode ?? '-'}</dd>
            </dl>
          ) : null}

          <section className="remote-sftp-mutation-panel" aria-label="SFTP 文件管理">
            <strong>文件管理</strong>
            <p>上传、新建目录、重命名和删除文件都需要二次确认；不提供在线内容编辑和目录递归删除。</p>

            <div className="remote-sftp-mutation-card">
              <label className="remote-sftp-file-picker">
                <span>上传文件</span>
                <input
                  type="file"
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setUploadFile(file);
                    if (file) setUploadPath(joinRemotePath(currentPath, file.name));
                  }}
                />
                <span className="remote-sftp-file-trigger">
                  <Upload size={13} />
                  选择文件
                </span>
                <small>{uploadFile ? uploadFile.name : '未选择任何文件'}</small>
              </label>
              <input
                className="input"
                value={uploadPath}
                onChange={(event) => setUploadPath(event.target.value)}
                placeholder="远程目标路径"
              />
              <label className="remote-sftp-check">
                <input
                  type="checkbox"
                  checked={confirmOverwrite}
                  onChange={(event) => setConfirmOverwrite(event.target.checked)}
                />
                覆盖已有文件
              </label>
              <button type="button" className="btn btn-primary" onClick={confirmUpload} disabled={mutationBusy}>
                <Upload size={14} />
                上传文件
              </button>
            </div>

            <div className="remote-sftp-mutation-card">
              <label>
                新建目录
                <input
                  className="input"
                  value={mkdirPath}
                  onChange={(event) => setMkdirPath(event.target.value)}
                  placeholder={joinRemotePath(currentPath, 'new-folder')}
                />
              </label>
              <button type="button" className="btn btn-ghost" onClick={confirmMkdir} disabled={mutationBusy}>
                新建目录
              </button>
            </div>

            <div className="remote-sftp-mutation-card">
              <label>
                重命名来源
                <input
                  className="input"
                  value={renameFromPath}
                  onChange={(event) => setRenameFromPath(event.target.value)}
                  placeholder="原路径"
                />
              </label>
              <label>
                重命名目标
                <input
                  className="input"
                  value={renameToPath}
                  onChange={(event) => setRenameToPath(event.target.value)}
                  placeholder="新路径"
                />
              </label>
              <button type="button" className="btn btn-ghost" onClick={confirmRename} disabled={mutationBusy}>
                重命名
              </button>
            </div>

            <div className="remote-sftp-mutation-card">
              <label>
                删除文件
                <input
                  className="input"
                  value={deletePath}
                  onChange={(event) => setDeletePath(event.target.value)}
                  placeholder="文件路径"
                />
              </label>
              <button type="button" className="btn btn-ghost danger" onClick={confirmDelete} disabled={mutationBusy}>
                删除文件
              </button>
            </div>
          </section>
        </aside>
      </main>

      <footer className={`remote-sftp-foot${error ? ' has-error' : ''}`}>
        {error ? <span>{error}</span> : <span>文件正文不写入审计或数据库；所有变更操作必须先确认。</span>}
      </footer>

      {pendingMutation ? (
        <div className="remote-sftp-confirm" role="dialog" aria-modal="true" aria-label="确认操作">
          <div className="remote-sftp-confirm-card">
            <strong>确认操作</strong>
            <p>{pendingMutation.title}</p>
            <code>{pendingMutation.summary}</code>
            <div className="remote-sftp-confirm-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setPendingMutation(null)} disabled={mutationBusy}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void runPendingMutation()} disabled={mutationBusy}>
                确认执行
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default SftpWorkspace;
