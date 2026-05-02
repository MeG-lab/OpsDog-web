import React from 'react';
import { Plus, Trash2, Eye, EyeOff, Download } from 'lucide-react';
import { useAppStore } from '../../stores';
import type { LLMProvider, LLMConfig } from '../../types';
import { fetchAvailableModels } from '../../services/runtime';

const PROVIDER_OPTIONS: Array<{
  value: LLMProvider;
  label: string;
  defaultBaseUrl?: string;
  supportsModelFetch: boolean;
}> = [
  { value: 'openai', label: 'OpenAI 兼容', defaultBaseUrl: 'https://api.openai.com/v1', supportsModelFetch: true },
  { value: 'aliyun', label: '阿里百炼', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', supportsModelFetch: true },
  { value: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1', supportsModelFetch: true },
  { value: 'siliconflow', label: '硅基流动', defaultBaseUrl: 'https://api.siliconflow.cn/v1', supportsModelFetch: true },
  { value: 'volcengine', label: '火山方舟', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', supportsModelFetch: true },
  { value: 'zhipu', label: '智谱 AI', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', supportsModelFetch: true },
  { value: 'moonshot', label: '月之暗面', defaultBaseUrl: 'https://api.moonshot.cn/v1', supportsModelFetch: true },
  { value: 'anthropic', label: 'Anthropic Claude', defaultBaseUrl: 'https://api.anthropic.com', supportsModelFetch: false },
  { value: 'google', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', supportsModelFetch: true },
  { value: 'custom', label: '自定义', supportsModelFetch: true },
];

const PROVIDER_LABELS = Object.fromEntries(PROVIDER_OPTIONS.map(option => [option.value, option.label])) as Record<LLMProvider, string>;
const BACKGROUND_PRESETS = [
  { value: 'white', label: '白色', color: '#ffffff' },
  { value: 'mist', label: '雾灰', color: '#f5f7fb' },
  { value: 'sage', label: '护眼绿', color: '#eef6ea' },
  { value: 'sand', label: '米杏', color: '#f6f0e5' },
  { value: 'sky', label: '浅青', color: '#edf5f8' },
  { value: 'lavender', label: '浅紫', color: '#f3eff9' },
] as const;

const SettingsPanel: React.FC = () => {
  const { llmConfigs, addLLMConfig, removeLLMConfig, activeModelId, setActiveModel,
    backgroundPreset, setBackgroundPreset } = useAppStore();

  const [showForm, setShowForm] = React.useState(false);
  const [showKeys, setShowKeys] = React.useState<Record<string, boolean>>({});
  const [modelFetchStatus, setModelFetchStatus] = React.useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [modelFetchError, setModelFetchError] = React.useState('');
  const [availableModels, setAvailableModels] = React.useState<string[]>([]);

  const empty: Omit<LLMConfig, 'id'> = { provider: 'openai', name: '', apiKey: '', baseUrl: '', modelName: '', maxTokens: 4096, temperature: 0.7 };
  const [form, setForm] = React.useState(empty);
  const selectedProvider = PROVIDER_OPTIONS.find(option => option.value === form.provider) ?? PROVIDER_OPTIONS[0];

  const handleAdd = () => {
    if (!form.name || !form.apiKey || !form.modelName) return;
    addLLMConfig(form);
    setForm(empty);
    setShowForm(false);
    setAvailableModels([]);
    setModelFetchStatus('idle');
    setModelFetchError('');
  };

  const handleProviderChange = (provider: LLMProvider) => {
    const nextProvider = PROVIDER_OPTIONS.find(option => option.value === provider);
    setForm(current => ({
      ...current,
      provider,
      baseUrl: nextProvider?.defaultBaseUrl ?? (provider === 'custom' ? current.baseUrl : ''),
      modelName: '',
      name: '',
    }));
    setAvailableModels([]);
    setModelFetchStatus('idle');
    setModelFetchError('');
  };

  const handleFetchModels = async () => {
    if (!form.apiKey.trim()) return;

    setModelFetchStatus('loading');
    setModelFetchError('');

    try {
      const models = await fetchAvailableModels({
        provider: form.provider,
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl?.trim() || undefined,
      });

      setAvailableModels(models);
      setModelFetchStatus('success');

      if (models[0] && !form.modelName) {
        setForm(current => ({
          ...current,
          modelName: models[0],
          name: current.name || models[0],
        }));
      }
    } catch (error) {
      setModelFetchStatus('error');
      setModelFetchError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div>
      {/* LLM Configs */}
      <div className="mb-2">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>LLM 模型</span>
          <button className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => setShowForm(s => !s)}>
            <Plus size={12} /> 添加
          </button>
        </div>

        {llmConfigs.map(c => (
          <div key={c.id} style={{ padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 6, marginBottom: 6, border: `1px solid ${c.id === activeModelId ? 'var(--accent)' : 'var(--border)'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500, flex: 1, color: 'var(--text-primary)' }}>{c.name}</span>
              <span className="badge badge-muted">{PROVIDER_LABELS[c.provider]}</span>
              <button className="btn-icon" style={{ width: 22, height: 22, padding: 3 }}
                onClick={() => { setShowKeys(s => ({ ...s, [c.id]: !s[c.id] })) }}>
                {showKeys[c.id] ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              {c.id !== activeModelId && (
                <button className="btn btn-ghost" style={{ padding: '2px 7px', fontSize: 11 }}
                  onClick={() => setActiveModel(c.id)}>启用</button>
              )}
              {c.id === activeModelId && (
                <span className="badge badge-accent">使用中</span>
              )}
              <button className="btn-icon" style={{ width: 22, height: 22, padding: 3, color: 'var(--danger)' }}
                onClick={() => removeLLMConfig(c.id)}>
                <Trash2 size={12} />
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
              {c.modelName} {showKeys[c.id] && `· ${c.apiKey}`}
            </div>
          </div>
        ))}

        {llmConfigs.length === 0 && !showForm && (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>尚未配置模型</div>
        )}

        {showForm && (
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 6 }}>
            <div className="form-row">
              <label className="label">名称</label>
              <input className="input" value={form.name} placeholder="GPT-4o" onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="form-row">
              <label className="label">提供商</label>
              <select className="input" value={form.provider} onChange={e => handleProviderChange(e.target.value as LLMProvider)}>
                {PROVIDER_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="form-row">
              <div className="form-label-row">
                <label className="label">模型名称</label>
                <button
                  className="btn btn-ghost model-fetch-btn"
                  type="button"
                  onClick={handleFetchModels}
                  disabled={!form.apiKey.trim() || modelFetchStatus === 'loading' || !selectedProvider.supportsModelFetch}
                >
                  <Download size={12} />
                  {modelFetchStatus === 'loading' ? '获取中...' : '获取模型列表'}
                </button>
              </div>
              <input className="input" value={form.modelName} placeholder="gpt-4o" onChange={e => setForm(f => ({ ...f, modelName: e.target.value }))} />
              {availableModels.length > 0 && (
                <select
                  className="input model-select"
                  value={form.modelName}
                  onChange={e => setForm(f => ({
                    ...f,
                    modelName: e.target.value,
                    name: f.name || e.target.value,
                  }))}
                >
                  {availableModels.map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              )}
              {modelFetchStatus === 'success' && availableModels.length > 0 && (
                <div className="model-fetch-hint">已获取 {availableModels.length} 个模型，可直接选择或继续手动填写。</div>
              )}
              {modelFetchStatus === 'error' && (
                <div className="model-fetch-error">{modelFetchError}</div>
              )}
              {!selectedProvider.supportsModelFetch && (
                <div className="model-fetch-hint">该提供商暂不支持自动获取模型列表，请手动填写模型名称。</div>
              )}
            </div>
            <div className="form-row">
              <label className="label">API Key</label>
              <input className="input" type="password" value={form.apiKey} placeholder="sk-..." onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} />
            </div>
            <div className="form-row">
              <label className="label">Base URL（可选）</label>
              <input
                className="input"
                value={form.baseUrl}
                placeholder={selectedProvider.defaultBaseUrl || 'https://api.openai.com/v1'}
                onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
              />
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => {
                setShowForm(false);
                setAvailableModels([]);
                setModelFetchStatus('idle');
                setModelFetchError('');
              }}>取消</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleAdd}
                disabled={!form.name || !form.apiKey || !form.modelName}>保存</button>
            </div>
          </div>
        )}
      </div>

      <div className="divider" />

      {/* Background */}
      <div className="settings-item">
        <span className="settings-item-label">背景颜色</span>
        <div className="background-presets">
          {BACKGROUND_PRESETS.map(preset => (
            <button
              key={preset.value}
              className={`background-preset-btn${backgroundPreset === preset.value ? ' active' : ''}`}
              onClick={() => setBackgroundPreset(preset.value)}
              title={preset.label}
            >
              <span className="background-preset-swatch" style={{ background: preset.color }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
