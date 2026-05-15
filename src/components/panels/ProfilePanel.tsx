import React from 'react';
import { PhoneCall, X } from 'lucide-react';
import { useAppStore, useToastStore } from '../../stores';
import { normalizeOperatorProfile } from '../../services/persistence';
import type { OperationsTeam } from '../../types';

const TEAM_OPTIONS: OperationsTeam[] = ['运维服务部', '渗透测试部'];

const ProfilePanel: React.FC = () => {
  const operatorProfile = useAppStore((state) => state.operatorProfile);
  const setOperatorProfile = useAppStore((state) => state.setOperatorProfile);
  const showToast = useToastStore((state) => state.showToast);
  const [draft, setDraft] = React.useState(() => normalizeOperatorProfile(operatorProfile));
  const [voiceConfigOpen, setVoiceConfigOpen] = React.useState(false);

  const updateDraft = (updates: Partial<typeof draft>) => {
    setDraft((current) => normalizeOperatorProfile({ ...current, ...updates }));
  };

  React.useEffect(() => {
    setDraft(normalizeOperatorProfile(operatorProfile));
  }, [operatorProfile]);

  React.useEffect(() => {
    if (!voiceConfigOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setVoiceConfigOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [voiceConfigOpen]);

  const saveProfile = () => {
    setOperatorProfile(normalizeOperatorProfile({
      ...draft,
      name: draft.name.trim(),
      organization: draft.organization.trim(),
      phone: draft.phone.trim(),
      email: draft.email.trim(),
      voiceAccessKeyId: draft.voiceAccessKeyId.trim(),
      voiceAccessKeySecret: draft.voiceAccessKeySecret.trim(),
      voiceNotifyNumbers: draft.voiceNotifyNumbers.trim(),
    }));
    showToast('保存成功', 'success');
  };

  const voiceNumberCount = draft.voiceNotifyNumbers
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean).length;
  const hasVoiceCredentials = Boolean(draft.voiceAccessKeyId.trim() && draft.voiceAccessKeySecret.trim());

  return (
    <>
      <div className="profile-panel">
        <section className="profile-panel-section">
          <div className="profile-panel-kicker">个人信息</div>
          <div className="profile-panel-grid">
            <label className="profile-panel-field">
              <span>姓名</span>
              <input
                className="input"
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder="请输入运维人员姓名"
              />
            </label>
            <label className="profile-panel-field">
              <span>所属团队</span>
              <select
                className="input"
                value={draft.team}
                onChange={(event) => updateDraft({ team: event.target.value as OperationsTeam })}
              >
                {TEAM_OPTIONS.map((team) => <option key={team} value={team}>{team}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="profile-panel-section">
          <div className="profile-panel-kicker">单位信息</div>
          <label className="profile-panel-field">
            <span>运维单位</span>
            <input
              className="input"
              value={draft.organization}
              onChange={(event) => updateDraft({ organization: event.target.value })}
              placeholder="请输入运维单位名称"
            />
          </label>
        </section>

        <section className="profile-panel-section">
          <div className="profile-panel-kicker">通知方式</div>
          <div className="profile-panel-grid">
            <label className="profile-panel-field">
              <span>电话</span>
              <input
                className="input"
                value={draft.phone}
                onChange={(event) => updateDraft({ phone: event.target.value })}
                placeholder="请输入联系电话"
              />
            </label>
            <label className="profile-panel-field">
              <span>邮箱</span>
              <input
                className="input"
                type="email"
                value={draft.email}
                onChange={(event) => updateDraft({ email: event.target.value })}
                placeholder="请输入邮箱地址"
              />
            </label>
          </div>
          <label className="toggle-row profile-panel-toggle">
            <input
              type="checkbox"
              checked={draft.voiceAlertEnabled}
              onChange={(event) => updateDraft({ voiceAlertEnabled: event.target.checked })}
            />
            <span>同时作为语音通知号码</span>
          </label>
        </section>

        <section className="profile-panel-section">
          <div className="profile-panel-kicker">语音服务配置</div>
          <div className="profile-panel-voice-summary">
            <div className="profile-panel-voice-meta">
              <div className="profile-panel-voice-title-row">
                <span className="profile-panel-voice-title">阿里云语音通知</span>
                <span className={`badge ${draft.voiceServiceEnabled ? 'badge-accent' : 'badge-muted'}`}>
                  {draft.voiceServiceEnabled ? '已启用' : '未启用'}
                </span>
              </div>
              <div className="profile-panel-voice-desc">
                {hasVoiceCredentials ? '已录入凭证' : '未配置凭证'} · {voiceNumberCount > 0 ? `${voiceNumberCount} 个通知号码` : '未配置通知号码'}
              </div>
            </div>
            <button type="button" className="toolbar-text-btn profile-panel-voice-trigger" onClick={() => setVoiceConfigOpen(true)}>
              <PhoneCall size={14} />
              <span>配置语音服务</span>
            </button>
          </div>
        </section>

        <div className="profile-panel-actions">
          <button type="button" className="toolbar-text-btn" onClick={saveProfile}>
            <span>保存资料</span>
          </button>
        </div>
      </div>

      {voiceConfigOpen && (
        <div className="scripts-upload-modal-backdrop" onClick={() => setVoiceConfigOpen(false)}>
          <div className="scripts-upload-modal profile-panel-voice-modal" onClick={(event) => event.stopPropagation()}>
            <div className="scripts-upload-modal-head">
              <div>
                <span className="scripts-upload-modal-kicker">Voice Service</span>
                <h3>语音服务配置</h3>
              </div>
              <button type="button" className="scripts-upload-modal-close" onClick={() => setVoiceConfigOpen(false)} aria-label="关闭语音服务配置">
                <X size={18} />
              </button>
            </div>
            <div className="scripts-upload-modal-body">
              <div className="profile-panel-grid">
                <label className="profile-panel-field">
                  <span>AccessKey ID</span>
                  <input
                    className="input"
                    value={draft.voiceAccessKeyId}
                    onChange={(event) => updateDraft({ voiceAccessKeyId: event.target.value })}
                    placeholder="请输入 AccessKey ID"
                    autoComplete="off"
                  />
                </label>
                <label className="profile-panel-field">
                  <span>AccessKey Secret</span>
                  <input
                    className="input"
                    type="password"
                    value={draft.voiceAccessKeySecret}
                    onChange={(event) => updateDraft({ voiceAccessKeySecret: event.target.value })}
                    placeholder="请输入 AccessKey Secret"
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <label className="profile-panel-field">
                <span>默认通知号码</span>
                <input
                  className="input"
                  value={draft.voiceNotifyNumbers}
                  onChange={(event) => updateDraft({ voiceNotifyNumbers: event.target.value })}
                  placeholder="多个号码用英文逗号分隔"
                />
              </label>
              <label className="toggle-row profile-panel-toggle">
                <input
                  type="checkbox"
                  checked={draft.voiceServiceEnabled}
                  onChange={(event) => updateDraft({ voiceServiceEnabled: event.target.checked })}
                />
                <span>启用语音服务</span>
              </label>
              <div className="profile-panel-hint">
                当前这块先作为界面预览保存；实际语音调用仍以项目根目录 `.env` 配置为准。
              </div>
            </div>
            <div className="scripts-upload-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setVoiceConfigOpen(false)}>
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  saveProfile();
                  setVoiceConfigOpen(false);
                }}
              >
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ProfilePanel;
