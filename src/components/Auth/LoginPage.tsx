import React from 'react';
import { Activity, LockKeyhole, ShieldCheck, TerminalSquare } from 'lucide-react';
import { getBackendHealth, login } from '../../services/runtime';
import type { AuthUser } from '../../services/runtime';

const LEGACY_CACHE_KEYS = [
  'aiops_web_runtime_config',
  'aiops_web_runtime_conversations',
  'aiops_conversations',
];

type LoginPageProps = {
  onAuthenticated: (user: AuthUser) => Promise<void> | void;
};

const clearLegacyBrowserCaches = () => {
  LEGACY_CACHE_KEYS.forEach((key) => window.localStorage.removeItem(key));
};

const LoginPage: React.FC<LoginPageProps> = ({ onAuthenticated }) => {
  const [username, setUsername] = React.useState('admin');
  const [password, setPassword] = React.useState('');
  const [backendOnline, setBackendOnline] = React.useState(false);
  const [backendMessage, setBackendMessage] = React.useState('正在连接后端');
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const health = await getBackendHealth();
        if (cancelled) return;
        setBackendOnline(true);
        setBackendMessage(`后端在线 · ${new Date(health.now).toLocaleTimeString('zh-CN', { hour12: false })}`);
      } catch (healthError) {
        if (cancelled) return;
        setBackendOnline(false);
        setBackendMessage(healthError instanceof Error ? healthError.message : String(healthError));
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('请输入用户名和密码。');
      return;
    }

    setSubmitting(true);
    try {
      const result = await login({ username: username.trim(), password });
      clearLegacyBrowserCaches();
      await onAuthenticated(result.user);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <section className="login-brief">
        <div className="login-brand">
          <ShieldCheck size={30} />
          <div>
            <span>OpsDog</span>
            <strong>智能运维控制台</strong>
          </div>
        </div>
        <div className="login-copy">
          <h1>统一入口，统一会话</h1>
          <p>登录后加载当前账号的模型配置和普通对话，设备、工具、工单等系统资源保持全局共享。</p>
        </div>
        <div className="login-status-panel">
          <div className="login-status-title">
            <TerminalSquare size={16} />
            <span>系统日志</span>
          </div>
          <div className={`login-status-row${backendOnline ? ' ok' : ' warn'}`}>
            <Activity size={14} />
            <span>后端</span>
            <strong>{backendOnline ? '在线' : '未连接'}</strong>
          </div>
          <div className="login-status-line">{backendMessage}</div>
          <div className="login-status-line">会话 Cookie 使用 HttpOnly 保存。</div>
        </div>
      </section>

      <section className="login-card" aria-label="登录">
        <div className="login-card-head">
          <LockKeyhole size={20} />
          <div>
            <h2>网页登录</h2>
            <p>请输入用户名和密码</p>
          </div>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="profile-panel-field">
            <span>用户名</span>
            <input
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="profile-panel-field">
            <span>密码</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <div className="system-settings-error">{error}</div>}
          <button type="submit" className="btn btn-primary login-submit" disabled={submitting}>
            <ShieldCheck size={15} />
            <span>{submitting ? '登录中...' : '登录'}</span>
          </button>
        </form>
      </section>
    </div>
  );
};

export default LoginPage;
