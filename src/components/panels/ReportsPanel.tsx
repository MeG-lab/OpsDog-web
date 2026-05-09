import React from 'react';
import { createPortal } from 'react-dom';
import { Download, Eye, FileText, RefreshCw, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clearReports, deleteReport, getReportContent, getReportDownloadUrl, listReports } from '../../services/runtime';
import type { ReportRecord } from '../../types';

const ReportsPanel: React.FC = () => {
  const [reports, setReports] = React.useState<ReportRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [previewFileName, setPreviewFileName] = React.useState('');
  const [previewContent, setPreviewContent] = React.useState('');
  const [previewUrl, setPreviewUrl] = React.useState('');
  const [previewLoading, setPreviewLoading] = React.useState(false);

  const refreshReports = React.useCallback(async () => {
    setLoading(true);
    try {
      const nextReports = await listReports();
      setReports(nextReports);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshReports();
  }, [refreshReports]);

  const previewReport = reports.find((item) => item.fileName === previewFileName) || null;
  const closePreview = () => {
    setPreviewFileName('');
    setPreviewContent('');
    setPreviewUrl('');
    setPreviewLoading(false);
  };

  const handleDownload = async (fileName: string) => {
    const url = await getReportDownloadUrl(fileName);
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleDelete = async (fileName: string) => {
    if (!window.confirm(`确定删除报告 ${fileName} 吗？`)) return;
    try {
      await deleteReport(fileName);
      setMessage(`已删除报告：${fileName}`);
      if (previewFileName === fileName) {
        closePreview();
      }
      await refreshReports();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleClear = async () => {
    if (!window.confirm('确定清空全部报告吗？')) return;
    try {
      await clearReports();
      setMessage('已清空全部报告。');
      closePreview();
      await refreshReports();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handlePreview = async (report: ReportRecord) => {
    setPreviewFileName(report.fileName);
    setPreviewContent('');
    setPreviewUrl('');
    setPreviewLoading(true);
    try {
      if (report.mimeType.startsWith('text/markdown') || report.mimeType.startsWith('text/')) {
        const result = await getReportContent(report.fileName);
        setPreviewContent(result.content);
      } else {
        const url = await getReportDownloadUrl(report.fileName);
        setPreviewUrl(url);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="reports-panel">
      <div className="toolbar-row">
        <span className="toolbar-note">{loading ? '正在加载报告...' : `已生成 ${reports.length} 份报告`}</span>
        <div className="toolbar-row">
          <button type="button" className="toolbar-text-btn" onClick={() => void refreshReports()}>
            <RefreshCw size={14} />
            <span>刷新</span>
          </button>
          <button type="button" className="toolbar-text-btn" onClick={() => void handleClear()} disabled={reports.length === 0}>
            <Trash2 size={14} />
            <span>清空</span>
          </button>
        </div>
      </div>

      {message ? <div className="toolbar-note">{message}</div> : null}

      <div className="reports-list compact">
        {reports.length === 0 ? (
          <div className="mcp-empty-state">还没有生成任何报告。</div>
        ) : (
          reports.map((report) => (
            <div key={report.fileName} className="reports-row">
              <div className="reports-row-main">
                <div className="reports-row-name" title={report.fileName}>{report.fileName}</div>
                <div className="reports-row-meta">
                  <span>{new Date(report.updatedAt).toLocaleString()}</span>
                  <span>{report.mimeType}</span>
                  <span>{(report.size / 1024).toFixed(1)} KB</span>
                </div>
              </div>
              <div className="reports-row-actions">
                <button type="button" className="toolbar-text-btn reports-action-btn" onClick={() => void handlePreview(report)} title="预览">
                  <Eye size={14} />
                </button>
                <button type="button" className="toolbar-text-btn reports-action-btn" onClick={() => void handleDownload(report.fileName)} title="下载">
                  <Download size={14} />
                </button>
                <button type="button" className="toolbar-text-btn reports-action-btn" onClick={() => void handleDelete(report.fileName)} title="删除">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {previewReport && typeof document !== 'undefined' ? createPortal(
        <div className="reports-preview-backdrop" onClick={closePreview}>
          <div className="reports-preview-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div className="reports-preview-head">
                <strong>{previewReport.fileName}</strong>
                <span>{previewReport.mimeType}</span>
              </div>
              <div className="reports-preview-header-actions">
                <button
                  type="button"
                  className="toolbar-text-btn"
                  onClick={() => void handleDownload(previewReport.fileName)}
                >
                  <Download size={14} />
                  <span>下载</span>
                </button>
                <button type="button" className="modal-close" onClick={closePreview}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="reports-preview-modal-body">
              {previewLoading ? (
                <div className="reports-binary-preview"><span>正在加载预览...</span></div>
              ) : previewReport.mimeType.startsWith('text/markdown') ? (
                <div className="reports-markdown-preview">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {previewContent || '暂无内容'}
                  </ReactMarkdown>
                </div>
              ) : previewReport.mimeType.startsWith('text/') ? (
                <pre className="tool-output reports-preview">{previewContent || '暂无内容'}</pre>
              ) : previewReport.mimeType === 'application/pdf' && previewUrl ? (
                <iframe className="reports-preview-frame" src={previewUrl} title={previewReport.fileName} />
              ) : (
                <div className="reports-binary-preview">
                  <FileText size={18} />
                  <span>该文件暂不支持内嵌预览，请下载查看。</span>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
};

export default ReportsPanel;
