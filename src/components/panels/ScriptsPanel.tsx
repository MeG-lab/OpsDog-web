import React from 'react';
import { Play, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { ScriptExecutionResult } from '../../types';

interface ScriptInfo {
  name: string;
  path: string;
  description: string;
  lastResult?: ScriptExecutionResult;
  running: boolean;
}

const ScriptsPanel: React.FC = () => {
  const [scripts, setScripts] = React.useState<ScriptInfo[]>([]);
  const [loading, setLoading] = React.useState(false);

  const scan = async () => {
    setLoading(true);
    try {
      await invoke<string>('get_app_data_dir');
      // Use the python command to find scripts in ~/.aiops/scripts/
      const result = await invoke<ScriptExecutionResult>('execute_python_script', {
        request: {
          scriptPath: '',
          args: ['-c', `
import os, json
d = os.path.expanduser('~/.aiops/scripts')
if not os.path.exists(d):
    print('[]')
else:
    items=[]
    for root, _, files in os.walk(d):
        for f in files:
            if f.endswith('.py'):
                p=os.path.join(root,f)
                desc=''
                with open(p) as fp:
                    for line in fp:
                        if line.strip().startswith('#'):
                            desc=line.strip().lstrip('#').strip()
                            break
                items.append({'name':f,'path':p,'description':desc})
    print(json.dumps(items))
          `.trim()],
          envVars: {},
          timeoutMs: 5000,
        },
      });
      const items = JSON.parse(result.stdout || '[]');
      setScripts(items.map((it: any) => ({ ...it, running: false })));
    } catch {
      // Fallback: show scripts from project directory
      setScripts([
        { name: 'monitor.py', path: 'scripts/managed/monitor.py', description: '系统监控脚本', running: false },
        { name: 'test_ping.py', path: 'scripts/instant/test_ping.py', description: '网络连通性检测脚本', running: false },
      ]);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { scan(); }, []);

  const runScript = async (idx: number) => {
    const s = scripts[idx];
    const updated = [...scripts];
    updated[idx] = { ...s, running: true };
    setScripts(updated);
    try {
      const result = await invoke<ScriptExecutionResult>('execute_python_script', {
        request: { scriptPath: s.path, args: [], envVars: {}, timeoutMs: 30000 },
      });
      updated[idx] = { ...updated[idx], running: false, lastResult: result };
    } catch (e) {
      updated[idx] = { ...updated[idx], running: false };
    }
    setScripts([...updated]);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={scan} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? '扫描中...' : '刷新'}
        </button>
      </div>

      {scripts.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
          未找到脚本<br />
          <span style={{ fontSize: 11 }}>将 .py 脚本放入 ~/.aiops/scripts/instant/ 或 ~/.aiops/scripts/managed/</span>
        </div>
      )}

      {scripts.map((s, i) => (
        <div key={s.path} className="script-item">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="script-name">{s.name}</div>
            <div className="script-desc">{s.description || s.path}</div>
            {s.lastResult && (
              <div style={{ fontSize: 11, color: s.lastResult.exitCode === 0 ? 'var(--success)' : 'var(--danger)', marginTop: 3 }}>
                {s.lastResult.exitCode === 0 ? '✓ 执行成功' : `✗ exit ${s.lastResult.exitCode}`}
                {s.lastResult.executionTimeMs && ` · ${s.lastResult.executionTimeMs}ms`}
              </div>
            )}
          </div>
          <button className="btn-icon" style={{ flexShrink: 0, color: s.running ? 'var(--text-tertiary)' : 'var(--accent)' }}
            onClick={() => runScript(i)} disabled={s.running} title="运行">
            {s.running ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
          </button>
        </div>
      ))}
    </div>
  );
};

export default ScriptsPanel;
