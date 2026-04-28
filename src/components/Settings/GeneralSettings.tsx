import React from 'react';
import { Check, AlertCircle, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../stores';
import { checkPythonEnvironment } from '../../services/tauri';

const GeneralSettings: React.FC = () => {
  const { pythonPath, setPythonPath } = useAppStore();
  const [pythonStatus, setPythonStatus] = React.useState<'checking' | 'ok' | 'error'>('checking');
  const [pythonVersion, setPythonVersion] = React.useState('');

  const checkPython = async () => {
    setPythonStatus('checking');
    try {
      const result = await checkPythonEnvironment();
      if (result.available) {
        setPythonStatus('ok');
        setPythonVersion(result.version);
      } else {
        setPythonStatus('error');
        setPythonVersion('');
      }
    } catch {
      setPythonStatus('error');
      setPythonVersion('');
    }
  };

  React.useEffect(() => {
    checkPython();
  }, []);

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-bg-input)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '8px 12px',
    fontSize: '14px',
    color: 'var(--color-text-primary)',
    outline: 'none',
    width: '100%',
    fontFamily: 'var(--font-sans)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
    marginBottom: '4px',
    display: 'block',
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
        通用设置
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--color-text-tertiary)' }}>
        应用基础配置和环境检测
      </p>

      {/* Python Environment */}
      <div
        className="rounded-2xl p-5 mb-6"
        style={{
          backgroundColor: 'var(--color-bg-card)',
          border: '1px solid var(--color-border-light)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--color-text-primary)' }}>
          🐍 Python 环境
          {pythonStatus === 'ok' && (
            <span className="flex items-center gap-1 text-xs font-normal px-2 py-0.5 rounded-md" style={{ backgroundColor: 'rgba(143, 185, 150, 0.15)', color: 'var(--color-accent-green)' }}>
              <Check size={11} />
              {pythonVersion}
            </span>
          )}
          {pythonStatus === 'error' && (
            <span className="flex items-center gap-1 text-xs font-normal px-2 py-0.5 rounded-md" style={{ backgroundColor: 'rgba(212, 114, 106, 0.15)', color: 'var(--color-accent-red)' }}>
              <AlertCircle size={11} />
              未检测到
            </span>
          )}
          {pythonStatus === 'checking' && (
            <span className="flex items-center gap-1 text-xs font-normal px-2 py-0.5 rounded-md" style={{ backgroundColor: 'var(--color-bg-secondary)', color: 'var(--color-text-tertiary)' }}>
              <RefreshCw size={11} className="animate-spin" />
              检测中...
            </span>
          )}
        </h3>

        <div className="mb-3">
          <label style={labelStyle}>Python 解释器路径</label>
          <div className="flex gap-2">
            <input
              style={inputStyle}
              value={pythonPath}
              onChange={(e) => setPythonPath(e.target.value)}
              placeholder="/usr/bin/python3"
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-focus)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-light)'; }}
            />
            <button
              onClick={checkPython}
              className="shrink-0 px-3 py-2 rounded-xl text-sm transition-colors cursor-pointer"
              style={{
                backgroundColor: 'var(--color-bg-button)',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border-light)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg-button-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg-button)'; }}
            >
              检测
            </button>
          </div>
          <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
            支持 Python 3.8+，推荐使用 3.9 - 3.12
          </p>
        </div>
      </div>

      {/* Data Storage */}
      <div
        className="rounded-2xl p-5 mb-6"
        style={{
          backgroundColor: 'var(--color-bg-card)',
          border: '1px solid var(--color-border-light)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
          📁 数据存储
        </h3>

        <div className="space-y-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          <div className="flex items-center justify-between py-1.5">
            <span>配置目录</span>
            <span className="font-mono text-xs" style={{ color: 'var(--color-text-tertiary)' }}>~/.aiops/</span>
          </div>
          <div className="flex items-center justify-between py-1.5" style={{ borderTop: '1px solid var(--color-border-light)' }}>
            <span>Skills 目录</span>
            <span className="font-mono text-xs" style={{ color: 'var(--color-text-tertiary)' }}>~/.aiops/skills/</span>
          </div>
          <div className="flex items-center justify-between py-1.5" style={{ borderTop: '1px solid var(--color-border-light)' }}>
            <span>对话历史</span>
            <span className="font-mono text-xs" style={{ color: 'var(--color-text-tertiary)' }}>~/.aiops/data/history.db</span>
          </div>
        </div>
      </div>

      {/* About */}
      <div
        className="rounded-2xl p-5"
        style={{
          backgroundColor: 'var(--color-bg-card)',
          border: '1px solid var(--color-border-light)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
          关于 AIops
        </h3>
        <div className="space-y-1 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
          <p>版本: 0.1.0 (Phase 1)</p>
          <p>框架: Tauri 2.0 + React 18</p>
          <p>理念: 对话即需求，脚本即功能</p>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettings;
