import React from 'react';
import {
  CircleDot,
  Network,
  Pencil,
  Plus,
  Router,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useAppStore, useToastStore } from '../../stores';
import { DEFAULT_ASSET_DEVICES } from '../../services/persistence';
import type { AssetDevice, AssetDeviceStatus, AssetDeviceType } from '../../types';

const DEVICE_TYPE_OPTIONS: Array<{ value: AssetDeviceType; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { value: 'switch', label: '交换机', icon: Network },
  { value: 'router', label: '路由器', icon: Router },
  { value: 'server', label: '服务器', icon: Server },
];

const STATUS_OPTIONS: Array<{ value: AssetDeviceStatus; label: string }> = [
  { value: 'healthy', label: '正常' },
  { value: 'attention', label: '关注' },
  { value: 'critical', label: '故障' },
];

const statusLabel: Record<AssetDeviceStatus, string> = {
  healthy: '正常',
  attention: '关注',
  critical: '故障',
};

const statusClassName: Record<AssetDeviceStatus, string> = {
  healthy: 'healthy',
  attention: 'attention',
  critical: 'critical',
};

const createEmptyDevice = (): AssetDevice => {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: '',
    assetId: '',
    ipAddress: '',
    deviceType: 'switch',
    status: 'healthy',
    location: '',
    model: '',
    manufacturer: '',
    serialNumber: '',
    organization: '',
    owner: '',
    remark: '',
    createdAt: now,
    updatedAt: now,
  };
};

const ServersWorkspace: React.FC = () => {
  const assetDevices = useAppStore((state) => state.assetDevices);
  const setAssetDevices = useAppStore((state) => state.setAssetDevices);
  const upsertAssetDevice = useAppStore((state) => state.upsertAssetDevice);
  const deleteAssetDevice = useAppStore((state) => state.deleteAssetDevice);
  const showToast = useToastStore((state) => state.showToast);

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<AssetDevice>(createEmptyDevice());
  const [mode, setMode] = React.useState<'create' | 'edit'>('create');

  React.useEffect(() => {
    if (assetDevices.length === 0) {
      setAssetDevices(DEFAULT_ASSET_DEVICES);
    }
  }, [assetDevices.length, setAssetDevices]);

  const totalDevices = assetDevices.length;

  const openCreate = () => {
    setMode('create');
    setDraft(createEmptyDevice());
    setEditorOpen(true);
  };

  const openEdit = (device: AssetDevice) => {
    setMode('edit');
    setDraft({ ...device });
    setEditorOpen(true);
  };

  const saveDevice = () => {
    const now = new Date().toISOString();
    const nextDevice: AssetDevice = {
      ...draft,
      name: draft.name.trim(),
      assetId: draft.assetId.trim(),
      ipAddress: draft.ipAddress.trim(),
      location: draft.location.trim(),
      model: draft.model.trim(),
      manufacturer: draft.manufacturer.trim(),
      serialNumber: draft.serialNumber.trim(),
      organization: draft.organization.trim(),
      owner: draft.owner.trim(),
      remark: draft.remark.trim(),
      createdAt: mode === 'create' ? now : draft.createdAt,
      updatedAt: now,
    };

    if (!nextDevice.name || !nextDevice.assetId || !nextDevice.ipAddress) {
      showToast('请填写设备名称、资产ID和IP地址', 'info');
      return;
    }

    upsertAssetDevice(nextDevice);
    setEditorOpen(false);
    showToast(mode === 'create' ? '设备已添加' : '设备已更新', 'success');
  };

  const removeDevice = (deviceId: string) => {
    deleteAssetDevice(deviceId);
    setEditorOpen(false);
    showToast('设备已删除', 'success');
  };

  return (
    <div className="servers-workspace">
      <section className="servers-hero">
        <div>
          <div className="servers-kicker">Server Inventory</div>
          <h1>服务器管理</h1>
          <p className="servers-subtitle">集中维护交换机、路由器和服务器资产信息，统一查看设备状态和详细资料。</p>
        </div>
        <div className="servers-toolbar">
          <button type="button" className="toolbar-text-btn" onClick={openCreate}>
            <Plus size={14} />
            <span>添加设备</span>
          </button>
        </div>
      </section>

      <section className="servers-stat-grid">
        <ServerStatCard label="全部设备" value={String(totalDevices)} icon={<CircleDot size={16} />} />
      </section>

      <section className="servers-grid">
        {assetDevices.map((device) => (
          <button
            key={device.id}
            type="button"
            className="server-device-card"
            onClick={() => openEdit(device)}
          >
            <div className="server-device-card-head">
              <span className={`server-device-icon ${device.deviceType}`}>
                {renderDeviceIcon(device.deviceType, 18)}
              </span>
              <button
                type="button"
                className="server-device-edit-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  openEdit(device);
                }}
                title="编辑设备"
              >
                <Pencil size={14} />
              </button>
            </div>
            <div className="server-device-card-body">
              <strong>{device.name}</strong>
              <span>{device.ipAddress}</span>
            </div>
            <div className="server-device-card-foot">
              <span className="server-device-type">{DEVICE_TYPE_OPTIONS.find((item) => item.value === device.deviceType)?.label}</span>
              <span className={`server-device-status ${statusClassName[device.status]}`}>
                <i />
                {statusLabel[device.status]}
              </span>
            </div>
          </button>
        ))}
      </section>

      {editorOpen && (
        <div className="scripts-upload-modal-backdrop" onClick={() => setEditorOpen(false)}>
          <div className="scripts-upload-modal server-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="scripts-upload-modal-head">
              <div>
                <span className="scripts-upload-modal-kicker">Server Asset</span>
                <h3>{mode === 'create' ? '添加设备' : '编辑设备'}</h3>
              </div>
              <button type="button" className="scripts-upload-modal-close" onClick={() => setEditorOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="scripts-upload-modal-body">
              <div className="server-editor-form-grid">
                <label className="profile-panel-field">
                  <span>设备类型</span>
                  <select className="input" value={draft.deviceType} onChange={(event) => setDraft((current) => ({ ...current, deviceType: event.target.value as AssetDeviceType }))}>
                    {DEVICE_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="profile-panel-field">
                  <span>设备名称</span>
                  <input className="input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>资产ID</span>
                  <input className="input" value={draft.assetId} onChange={(event) => setDraft((current) => ({ ...current, assetId: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>IP 地址</span>
                  <input className="input" value={draft.ipAddress} onChange={(event) => setDraft((current) => ({ ...current, ipAddress: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>存活状态</span>
                  <select className="input" value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as AssetDeviceStatus }))}>
                    {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="profile-panel-field">
                  <span>所属单位</span>
                  <input className="input" value={draft.organization} onChange={(event) => setDraft((current) => ({ ...current, organization: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>负责人</span>
                  <input className="input" value={draft.owner} onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>设备位置</span>
                  <input className="input" value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>厂商</span>
                  <input className="input" value={draft.manufacturer} onChange={(event) => setDraft((current) => ({ ...current, manufacturer: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>型号</span>
                  <input className="input" value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>序列号</span>
                  <input className="input" value={draft.serialNumber} onChange={(event) => setDraft((current) => ({ ...current, serialNumber: event.target.value }))} />
                </label>
              </div>
              <label className="profile-panel-field">
                <span>备注</span>
                <textarea
                  className="textarea"
                  rows={4}
                  value={draft.remark}
                  onChange={(event) => setDraft((current) => ({ ...current, remark: event.target.value }))}
                  placeholder="填写补充资产信息"
                />
              </label>
            </div>
            <div className="scripts-upload-modal-actions server-editor-actions">
              {mode === 'edit' ? (
                <button type="button" className="btn btn-ghost danger" onClick={() => removeDevice(draft.id)}>
                  <Trash2 size={14} />
                  删除设备
                </button>
              ) : <span />}
              <div className="server-editor-action-group">
                <button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)}>取消</button>
                <button type="button" className="btn btn-primary" onClick={saveDevice}>{mode === 'create' ? '保存并添加' : '保存修改'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ServerStatCard: React.FC<{ label: string; value: string; icon: React.ReactNode }> = ({ label, value, icon }) => (
  <div className="server-stat-card">
    <span className="server-stat-icon">{icon}</span>
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  </div>
);

function renderDeviceIcon(type: AssetDeviceType, size = 18) {
  if (type === 'router') return <Router size={size} />;
  if (type === 'server') return <Server size={size} />;
  return <Network size={size} />;
}

export default ServersWorkspace;
