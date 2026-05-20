import React from 'react';
import {
  CircleDot,
  Eye,
  HardDrive,
  Network,
  Pencil,
  Plus,
  Server,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { useAppStore, useToastStore } from '../../stores';
import { DEFAULT_ASSET_DEVICES } from '../../services/persistence';
import { fetchAssetDevicesExample } from '../../services/assetDevices';
import { createAssetDevice, deleteAssetDevice as deleteAssetDeviceRecord, updateAssetDevice } from '../../services/runtime';
import type { AssetDevice, AssetDeviceStatus, AssetDeviceType } from '../../types';

const DEVICE_TYPE_OPTIONS: Array<{ value: AssetDeviceType; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { value: 'server', label: '服务器', icon: Server },
  { value: 'storage', label: '存储设备', icon: HardDrive },
  { value: 'security', label: '安全设备', icon: Shield },
  { value: 'network', label: '网络设备', icon: Network },
];
const ALL_DEVICE_FILTER = 'all';

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
    deviceType: 'server',
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

const isReadonlyAssetDevice = (device: AssetDevice) => device.id.startsWith('remote:');
const getAssetSourceLabel = (device: AssetDevice) => isReadonlyAssetDevice(device) ? '远程拉取' : '用户添加';

const ServersWorkspace: React.FC = () => {
  const assetDevices = useAppStore((state) => state.assetDevices);
  const setAssetDevices = useAppStore((state) => state.setAssetDevices);
  const showToast = useToastStore((state) => state.showToast);

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<AssetDevice>(createEmptyDevice());
  const [mode, setMode] = React.useState<'create' | 'edit' | 'view'>('create');
  const [loadingRemoteAssets, setLoadingRemoteAssets] = React.useState(false);
  const [remoteLoaded, setRemoteLoaded] = React.useState(false);
  const [searchKeyword, setSearchKeyword] = React.useState('');
  const [activeTypeFilter, setActiveTypeFilter] = React.useState<AssetDeviceType | typeof ALL_DEVICE_FILTER>(ALL_DEVICE_FILTER);
  const [savingDevice, setSavingDevice] = React.useState(false);
  const [deletingDevice, setDeletingDevice] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    const loadRemoteAssets = async () => {
      setLoadingRemoteAssets(true);
      try {
        const devices = await fetchAssetDevicesExample();
        if (cancelled) return;
        if (devices.length > 0) {
          setAssetDevices(devices);
        } else if (assetDevices.length === 0) {
          setAssetDevices(DEFAULT_ASSET_DEVICES);
        }
        setRemoteLoaded(true);
      } catch (error) {
        if (cancelled) return;
        if (assetDevices.length === 0) {
          setAssetDevices(DEFAULT_ASSET_DEVICES);
        }
        showToast(
          error instanceof Error ? `资产接口加载失败，已回退默认数据：${error.message}` : '资产接口加载失败，已回退默认数据',
          'info',
        );
      } finally {
        if (!cancelled) {
          setLoadingRemoteAssets(false);
        }
      }
    };

    void loadRemoteAssets();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchAssetDevicesExample().then((devices) => {
        if (devices.length > 0) {
          setAssetDevices(devices);
        }
      }).catch(() => {});
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [setAssetDevices]);

  const filteredDevices = React.useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();

    return assetDevices.filter((device) => {
      if (activeTypeFilter !== ALL_DEVICE_FILTER && device.deviceType !== activeTypeFilter) {
        return false;
      }

      if (!keyword) return true;

      return device.name.toLowerCase().includes(keyword) || device.ipAddress.toLowerCase().includes(keyword);
    });
  }, [activeTypeFilter, assetDevices, searchKeyword]);

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

  const openView = (device: AssetDevice) => {
    setMode('view');
    setDraft({ ...device });
    setEditorOpen(true);
  };

  const saveDevice = async () => {
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

    if (!nextDevice.name || !nextDevice.ipAddress) {
      showToast('请填写设备名称和IP地址', 'info');
      return;
    }

    if ((mode === 'edit' || mode === 'view') && isReadonlyAssetDevice(nextDevice)) {
      showToast('远端同步资产当前为只读，暂不支持直接修改。', 'info');
      return;
    }

    setSavingDevice(true);
    try {
      const saved = mode === 'create'
        ? await createAssetDevice(nextDevice)
        : await updateAssetDevice(nextDevice.id, nextDevice);
      setAssetDevices(mode === 'create'
        ? [saved, ...assetDevices]
        : assetDevices.map((item) => (item.id === saved.id ? saved : item)));
      setEditorOpen(false);
      showToast(mode === 'create' ? '设备已添加' : '设备已更新', 'success');
    } catch (error) {
      showToast(error instanceof Error ? `保存失败：${error.message}` : '保存失败', 'error');
    } finally {
      setSavingDevice(false);
    }
  };

  const removeDevice = async (deviceId: string) => {
    if (deviceId.startsWith('remote:')) {
      showToast('远端同步资产当前为只读，暂不支持直接删除。', 'info');
      return;
    }
    setDeletingDevice(true);
    try {
      await deleteAssetDeviceRecord(deviceId);
      setAssetDevices(assetDevices.filter((item) => item.id !== deviceId));
      setEditorOpen(false);
      showToast('设备已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'error');
    } finally {
      setDeletingDevice(false);
    }
  };

  return (
    <div className="servers-workspace">
      <section className="servers-hero">
        <div>
          <div className="servers-kicker">Server Inventory</div>
          <h1>设备管理</h1>
          <p className="servers-subtitle">集中维护服务器、存储设备、安全设备和网络设备资产信息，统一查看设备状态和详细资料。</p>
        </div>
        <div className="servers-toolbar">
          <span className="servers-data-badge">
            {loadingRemoteAssets ? '正在加载设备台账' : remoteLoaded ? '设备台账已加载' : '使用默认数据'}
          </span>
          <button type="button" className="toolbar-text-btn" onClick={openCreate}>
            <Plus size={14} />
            <span>添加设备</span>
          </button>
        </div>
      </section>

      <section className="servers-stat-grid">
        <ServerStatCard label="全部设备" value={String(totalDevices)} icon={<CircleDot size={16} />} />
      </section>

      <section className="servers-filter-bar">
        <div className="servers-filter-tags">
          <button
            type="button"
            className={`servers-filter-chip${activeTypeFilter === ALL_DEVICE_FILTER ? ' active' : ''}`}
            onClick={() => setActiveTypeFilter(ALL_DEVICE_FILTER)}
          >
            全部
          </button>
          {DEVICE_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`servers-filter-chip${activeTypeFilter === option.value ? ' active' : ''}`}
              onClick={() => setActiveTypeFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="servers-search-box">
          <input
            className="input"
            value={searchKeyword}
            onChange={(event) => setSearchKeyword(event.target.value)}
            placeholder="根据 IP 或设备名称查找设备"
          />
        </label>
      </section>

      <section className="servers-grid">
        {filteredDevices.map((device) => (
          <button
            key={device.id}
            type="button"
            className="server-device-card"
            onClick={() => {
              if (isReadonlyAssetDevice(device)) {
                openView(device);
                return;
              }
              openEdit(device);
            }}
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
                  if (isReadonlyAssetDevice(device)) {
                    openView(device);
                    return;
                  }
                  openEdit(device);
                }}
                title={isReadonlyAssetDevice(device) ? '查看详情' : '编辑设备'}
              >
                {isReadonlyAssetDevice(device) ? <Eye size={14} /> : <Pencil size={14} />}
              </button>
            </div>
            <div className="server-device-card-body">
              <span className={`server-device-source ${isReadonlyAssetDevice(device) ? 'remote' : 'local'}`}>
                {getAssetSourceLabel(device)}
              </span>
              <strong>{device.name}</strong>
              <span className="server-device-ip">{device.ipAddress}</span>
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
        {filteredDevices.length === 0 ? (
          <div className="servers-empty-state">
            <strong>未找到匹配设备</strong>
            <span>请调整设备类型标签或搜索关键词。</span>
          </div>
        ) : null}
      </section>

      {editorOpen && (
        <div className="scripts-upload-modal-backdrop" onClick={() => setEditorOpen(false)}>
          <div className="scripts-upload-modal server-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="scripts-upload-modal-head">
              <div>
                <span className="scripts-upload-modal-kicker">Server Asset</span>
                <h3>{mode === 'create' ? '添加设备' : mode === 'view' ? '查看设备' : '编辑设备'}</h3>
              </div>
              <button type="button" className="scripts-upload-modal-close" onClick={() => setEditorOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="scripts-upload-modal-body">
              <div className="server-editor-form-grid">
                <label className="profile-panel-field">
                  <span>设备类型</span>
                  <select disabled={mode === 'view'} className="input" value={draft.deviceType} onChange={(event) => setDraft((current) => ({ ...current, deviceType: event.target.value as AssetDeviceType }))}>
                    {DEVICE_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="profile-panel-field">
                  <span>设备名称</span>
                  <input disabled={mode === 'view'} className="input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>资产ID</span>
                  <input disabled={mode === 'view'} className="input" value={draft.assetId} onChange={(event) => setDraft((current) => ({ ...current, assetId: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>IP 地址</span>
                  <input disabled={mode === 'view'} className="input" value={draft.ipAddress} onChange={(event) => setDraft((current) => ({ ...current, ipAddress: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>存活状态</span>
                  <select disabled={mode === 'view'} className="input" value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as AssetDeviceStatus }))}>
                    {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="profile-panel-field">
                  <span>所属单位</span>
                  <input disabled={mode === 'view'} className="input" value={draft.organization} onChange={(event) => setDraft((current) => ({ ...current, organization: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>负责人</span>
                  <input disabled={mode === 'view'} className="input" value={draft.owner} onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>设备位置</span>
                  <input disabled={mode === 'view'} className="input" value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>厂商</span>
                  <input disabled={mode === 'view'} className="input" value={draft.manufacturer} onChange={(event) => setDraft((current) => ({ ...current, manufacturer: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>型号</span>
                  <input disabled={mode === 'view'} className="input" value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} />
                </label>
                <label className="profile-panel-field">
                  <span>序列号</span>
                  <input disabled={mode === 'view'} className="input" value={draft.serialNumber} onChange={(event) => setDraft((current) => ({ ...current, serialNumber: event.target.value }))} />
                </label>
              </div>
              <label className="profile-panel-field">
                <span>备注</span>
                <textarea
                  className="textarea"
                  disabled={mode === 'view'}
                  rows={4}
                  value={draft.remark}
                  onChange={(event) => setDraft((current) => ({ ...current, remark: event.target.value }))}
                  placeholder="填写补充资产信息"
                />
              </label>
            </div>
            <div className="scripts-upload-modal-actions server-editor-actions">
              {mode === 'edit' ? (
                <button type="button" className="btn btn-ghost danger" onClick={() => void removeDevice(draft.id)} disabled={deletingDevice}>
                  <Trash2 size={14} />
                  {deletingDevice ? '删除中...' : '删除设备'}
                </button>
              ) : <span />}
              <div className="server-editor-action-group">
                <button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)}>{mode === 'view' ? '关闭' : '取消'}</button>
                {mode !== 'view' ? (
                  <button type="button" className="btn btn-primary" onClick={() => void saveDevice()} disabled={savingDevice}>
                    {savingDevice ? '保存中...' : mode === 'create' ? '保存并添加' : '保存修改'}
                  </button>
                ) : null}
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
  if (type === 'server') return <Server size={size} />;
  if (type === 'storage') return <HardDrive size={size} />;
  if (type === 'security') return <Shield size={size} />;
  return <Network size={size} />;
}

export default ServersWorkspace;
