import React from 'react';
import { createPortal } from 'react-dom';
import {
  CircleDot,
  Columns2,
  Eye,
  FolderOpen,
  HardDrive,
  KeyRound,
  Minimize2,
  Network,
  Pencil,
  Plus,
  Server,
  Shield,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useAppStore, useToastStore } from '../../stores';
import { fetchAssetDevicesExample } from '../../services/assetDevices';
import { createClientId } from '../../utils/createClientId';
import {
  createAssetDevice,
  createConnectionProfile,
  createRemoteTerminalToken,
  createSftpSession,
  closeSftpSession,
  deleteAssetDevice as deleteAssetDeviceRecord,
  deleteConnectionProfile,
  listConnectionProfiles,
  testRemoteConnection,
  trustSshHostKey,
  updateAssetDevice,
  updateConnectionProfile,
} from '../../services/runtime';
import type {
  ConnectionProfile,
  ConnectionProfileCreateRequest,
  ConnectionProfileUpdateRequest,
  RemoteConnectionTestResponse,
  SshConnectionTestResult,
  SshHostKeyView,
  SftpSessionReady,
  TelnetConnectionTestResult,
} from '../../services/runtime';
import type { AssetDevice, AssetDeviceStatus, AssetDeviceType } from '../../types';

const DEVICE_TYPE_OPTIONS: Array<{ value: AssetDeviceType; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { value: 'server', label: '服务器', icon: Server },
  { value: 'storage', label: '存储设备', icon: HardDrive },
  { value: 'security', label: '安全设备', icon: Shield },
  { value: 'network', label: '网络设备', icon: Network },
];
const ALL_DEVICE_FILTER = 'all';
const TerminalWorkspace = React.lazy(() => import('../Remote/TerminalWorkspace'));
const SftpWorkspace = React.lazy(() => import('../Remote/SftpWorkspace'));

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
    id: createClientId('asset-device'),
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

type RemoteProfileDraft = {
  id: string | null;
  protocol: 'ssh' | 'telnet';
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  sftpEnabled: boolean;
  isDefault: boolean;
};

const createEmptyRemoteProfile = (device: AssetDevice): RemoteProfileDraft => ({
  id: null,
  protocol: 'ssh',
  name: `${device.name || '设备'} SSH`,
  host: device.ipAddress,
  port: '22',
  username: '',
  password: '',
  sftpEnabled: true,
  isDefault: false,
});

const editRemoteProfile = (profile: ConnectionProfile): RemoteProfileDraft => ({
  id: profile.id,
  protocol: profile.protocol,
  name: profile.name,
  host: profile.host,
  port: String(profile.port),
  username: profile.username,
  password: '',
  sftpEnabled: profile.sftpEnabled,
  isDefault: profile.isDefault,
});

const getRemoteProtocolLabel = (protocol: RemoteProfileDraft['protocol'] | ConnectionProfile['protocol']) =>
  protocol === 'telnet' ? 'TELNET' : 'SSH';

const getRemoteTargetLabel = (profile: Pick<ConnectionProfile, 'host' | 'port' | 'username'>) =>
  profile.username ? `${profile.username}@${profile.host}:${profile.port}` : `${profile.host}:${profile.port}`;

const getRemoteAuthErrorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  return /auth|authentication|login|password|username|认证|密码|用户名/i.test(message)
    ? '认证失败，请检查用户名或密码'
    : message;
};

type HostKeyNextAction = 'test' | 'terminal' | 'sftp';

type ConnectionCheckState = {
  busy: boolean;
  hostKey?: SshHostKeyView;
  result?: SshConnectionTestResult | TelnetConnectionTestResult;
  error?: string;
  nextAction?: HostKeyNextAction;
};

type RemoteAccessTab =
  | {
      id: string;
      kind: 'terminal';
      deviceId: string;
      deviceName: string;
      profileId: string;
      profileLabel: string;
      targetLabel: string;
      host: string;
      port: number;
      protocol: ConnectionProfile['protocol'];
      token: string;
      openedAt: string;
    }
  | {
      id: string;
      kind: 'sftp';
      deviceId: string;
      deviceName: string;
      profileId: string;
      profileLabel: string;
      targetLabel: string;
      host: string;
      port: number;
      protocol: 'ssh';
      sessionId: string;
      openedAt: string;
    };

const getLastRemoteTabId = (tabs: RemoteAccessTab[]) => tabs.length > 0 ? tabs[tabs.length - 1].id : null;

const isSftpSessionReady = (response: Awaited<ReturnType<typeof createSftpSession>>): response is SftpSessionReady =>
  'session' in response;

const ServersWorkspace: React.FC = () => {
  const assetDevices = useAppStore((state) => state.assetDevices);
  const operatorProfile = useAppStore((state) => state.operatorProfile);
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
  // 添加新场地/厂商/型号的输入态
  const [addingLocation, setAddingLocation] = React.useState(false);
  const [addingManufacturer, setAddingManufacturer] = React.useState(false);
  const [addingModel, setAddingModel] = React.useState(false);
  const [newLocationInput, setNewLocationInput] = React.useState('');
  const [newManufacturerInput, setNewManufacturerInput] = React.useState('');
  const [newModelInput, setNewModelInput] = React.useState('');
  // 临时追加的新选项（还没保存到设备列表中的）
  const [tempLocations, setTempLocations] = React.useState<string[]>([]);
  const [tempManufacturers, setTempManufacturers] = React.useState<string[]>([]);
  const [tempModels, setTempModels] = React.useState<string[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(null);
  const [remoteTabs, setRemoteTabs] = React.useState<RemoteAccessTab[]>([]);
  const [activeRemoteTabId, setActiveRemoteTabId] = React.useState<string | null>(null);
  const [splitTabId, setSplitTabId] = React.useState<string | null>(null);
  const [remoteAccessMinimized, setRemoteAccessMinimized] = React.useState(false);
  const remoteTabsRef = React.useRef<RemoteAccessTab[]>([]);

  React.useEffect(() => {
    remoteTabsRef.current = remoteTabs;
  }, [remoteTabs]);

  const closeSftpTabSession = (tab: RemoteAccessTab) => {
    if (tab.kind !== 'sftp') return Promise.resolve();
    return closeSftpSession(tab.sessionId).catch(() => {});
  };

  const closeRemoteTabsWhere = React.useCallback(async (predicate: (tab: RemoteAccessTab) => boolean) => {
    const currentTabs = remoteTabsRef.current;
    const closingTabs = currentTabs.filter(predicate);
    if (closingTabs.length === 0) return;
    const closeSftpSessions = closingTabs.map(closeSftpTabSession);
    const nextTabs = currentTabs.filter((tab) => !predicate(tab));
    setRemoteTabs(nextTabs);
    setActiveRemoteTabId((current) => (
      current && nextTabs.some((tab) => tab.id === current) ? current : getLastRemoteTabId(nextTabs)
    ));
    setSplitTabId((current) => (
      current && nextTabs.some((tab) => tab.id === current) ? current : null
    ));
    if (nextTabs.length === 0) setRemoteAccessMinimized(false);
    await Promise.all(closeSftpSessions);
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }, []);

  const closeRemoteTab = React.useCallback((tabId: string) => {
    closeRemoteTabsWhere((tab) => tab.id === tabId);
  }, [closeRemoteTabsWhere]);

  const closeAllRemoteTabs = React.useCallback(() => {
    remoteTabsRef.current.forEach((tab) => {
      void closeSftpTabSession(tab);
    });
    setRemoteTabs([]);
    setActiveRemoteTabId(null);
    setSplitTabId(null);
    setRemoteAccessMinimized(false);
  }, []);

  const closeRemoteTabsForProfile = React.useCallback((profileId: string) => {
    return closeRemoteTabsWhere((tab) => tab.profileId === profileId);
  }, [closeRemoteTabsWhere]);

  const closeRemoteTabsForDevice = React.useCallback((deviceId: string) => {
    return closeRemoteTabsWhere((tab) => tab.deviceId === deviceId);
  }, [closeRemoteTabsWhere]);

  React.useEffect(() => () => {
    remoteTabsRef.current.forEach((tab) => {
      void closeSftpTabSession(tab);
    });
  }, []);

  React.useEffect(() => {
    if (!splitTabId || splitTabId !== activeRemoteTabId) return;
    setSplitTabId(remoteTabs.find((tab) => tab.id !== activeRemoteTabId)?.id ?? null);
  }, [activeRemoteTabId, remoteTabs, splitTabId]);

  const addRemoteTab = React.useCallback((tab: RemoteAccessTab) => {
    setRemoteTabs((current) => [...current, tab]);
    setActiveRemoteTabId(tab.id);
    setRemoteAccessMinimized(false);
  }, []);

  const openRemoteTerminalTab = React.useCallback((device: AssetDevice, profile: ConnectionProfile, token: string) => {
    addRemoteTab({
      id: createClientId('remote-tab'),
      kind: 'terminal',
      deviceId: device.id,
      deviceName: device.name,
      profileId: profile.id,
      profileLabel: profile.name,
      targetLabel: getRemoteTargetLabel(profile),
      host: profile.host,
      port: profile.port,
      protocol: profile.protocol,
      token,
      openedAt: new Date().toISOString(),
    });
  }, [addRemoteTab]);

  const openRemoteSftpTab = React.useCallback((device: AssetDevice, profile: ConnectionProfile, session: SftpSessionReady['session']) => {
    addRemoteTab({
      id: createClientId('remote-tab'),
      kind: 'sftp',
      deviceId: device.id,
      deviceName: device.name,
      profileId: profile.id,
      profileLabel: profile.name,
      targetLabel: getRemoteTargetLabel(profile),
      host: profile.host,
      port: profile.port,
      protocol: 'ssh',
      sessionId: session.id,
      openedAt: session.openedAt,
    });
  }, [addRemoteTab]);

  const toggleSplitMode = () => {
    if (splitTabId) {
      setSplitTabId(null);
      return;
    }
    setSplitTabId(remoteTabs.find((tab) => tab.id !== activeRemoteTabId)?.id ?? null);
  };

  const renderRemoteTabContent = (tab: RemoteAccessTab, visible: boolean, active: boolean) => (
    <React.Suspense fallback={<div className="remote-terminal-loading">正在加载远程访问组件...</div>}>
      {tab.kind === 'terminal' ? (
        <TerminalWorkspace
          profileLabel={tab.profileLabel}
          targetLabel={tab.targetLabel}
          protocol={tab.protocol}
          token={tab.token}
          visible={visible}
          active={active}
          onClose={() => closeRemoteTab(tab.id)}
        />
      ) : (
        <SftpWorkspace
          profileLabel={tab.profileLabel}
          targetLabel={tab.targetLabel}
          sessionId={tab.sessionId}
          onClose={() => closeRemoteTab(tab.id)}
        />
      )}
    </React.Suspense>
  );

  React.useEffect(() => {
    let cancelled = false;

    const loadRemoteAssets = async () => {
      setLoadingRemoteAssets(true);
      try {
        const devices = await fetchAssetDevicesExample();
        if (cancelled) return;
        setAssetDevices(devices);
        setRemoteLoaded(true);
      } catch (error) {
        if (cancelled) return;
        showToast(
          error instanceof Error ? `资产接口加载失败：${error.message}` : '资产接口加载失败',
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
        setAssetDevices(devices);
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

  const uniqueLocations = React.useMemo(() =>
    [...new Set([...assetDevices.map(d => d.location), ...tempLocations].filter(Boolean))].sort(),
    [assetDevices, tempLocations],
  );
  const uniqueManufacturers = React.useMemo(() =>
    [...new Set([...assetDevices.map(d => d.manufacturer), ...tempManufacturers].filter(Boolean))].sort(),
    [assetDevices, tempManufacturers],
  );
  const uniqueModels = React.useMemo(() =>
    [...new Set([...assetDevices.map(d => d.model), ...tempModels].filter(Boolean))].sort(),
    [assetDevices, tempModels],
  );
  // 型号按选中的厂商过滤
  const filteredModels = React.useMemo(() => {
    if (!draft.manufacturer) return uniqueModels;
    const vendorModels = assetDevices
      .filter(d => d.manufacturer === draft.manufacturer)
      .map(d => d.model)
      .filter(Boolean);
    return [...new Set([...vendorModels, ...tempModels])].sort();
  }, [assetDevices, draft.manufacturer, uniqueModels, tempModels]);

  const totalDevices = assetDevices.length;
  const selectedDevice = React.useMemo(
    () => assetDevices.find((device) => device.id === selectedDeviceId) || null,
    [assetDevices, selectedDeviceId],
  );

  const openCreate = () => {
    setMode('create');
    setDraft({
      ...createEmptyDevice(),
      organization: operatorProfile.organization.trim(),
      owner: operatorProfile.name.trim(),
    });
    setAddingLocation(false);
    setAddingManufacturer(false);
    setAddingModel(false);
    setEditorOpen(true);
  };

  const openEdit = (device: AssetDevice) => {
    setMode('edit');
    setDraft({ ...device });
    setAddingLocation(false);
    setAddingManufacturer(false);
    setAddingModel(false);
    setEditorOpen(true);
  };

  const openView = (device: AssetDevice) => {
    setMode('view');
    setDraft({ ...device });
    setAddingLocation(false);
    setAddingManufacturer(false);
    setAddingModel(false);
    setEditorOpen(true);
  };

  const openDeviceDetails = (device: AssetDevice) => {
    setSelectedDeviceId(device.id);
  };

  const handleDeviceCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, device: AssetDevice) => {
    if (event.currentTarget !== event.target) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openDeviceDetails(device);
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
      setSelectedDeviceId(saved.id);
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
      await closeRemoteTabsForDevice(deviceId);
      await deleteAssetDeviceRecord(deviceId);
      setAssetDevices(assetDevices.filter((item) => item.id !== deviceId));
      if (selectedDeviceId === deviceId) setSelectedDeviceId(null);
      setEditorOpen(false);
      showToast('设备已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? `删除失败：${error.message}` : '删除失败', 'error');
    } finally {
      setDeletingDevice(false);
    }
  };

  return (
    <div className={`servers-workspace${selectedDevice ? ' has-device-drawer' : ''}`}>
      <main className="servers-main-panel">
        <section className="servers-hero">
        <div>
          <div className="servers-kicker">Server Inventory</div>
          <h1>设备管理</h1>
          <p className="servers-subtitle">集中维护服务器、存储设备、安全设备和网络设备资产信息，统一查看设备状态和详细资料。</p>
        </div>
        <div className="servers-toolbar">
          <span className="servers-data-badge">
            {loadingRemoteAssets ? '正在加载设备台账' : remoteLoaded ? '设备台账已加载' : '设备台账未加载'}
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
            <div
              key={device.id}
              role="button"
              tabIndex={0}
              className="server-device-card"
              aria-label={`查看设备 ${device.name}`}
              onClick={() => openDeviceDetails(device)}
              onKeyDown={(event) => handleDeviceCardKeyDown(event, device)}
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
            </div>
          ))}
          {filteredDevices.length === 0 ? (
            <div className="servers-empty-state">
              <strong>未找到匹配设备</strong>
              <span>请调整设备类型标签或搜索关键词。</span>
            </div>
          ) : null}
        </section>
      </main>

      {selectedDevice ? (
        <DeviceDetailsDrawer
          key={selectedDevice.id}
          device={selectedDevice}
          onClose={() => setSelectedDeviceId(null)}
          onEdit={() => {
            const deviceToEdit = selectedDevice;
            setSelectedDeviceId(null);
            if (isReadonlyAssetDevice(selectedDevice)) {
              openView(deviceToEdit);
              return;
            }
            openEdit(deviceToEdit);
          }}
          onOpenTerminal={openRemoteTerminalTab}
          onOpenSftp={openRemoteSftpTab}
          onCloseProfileTabs={closeRemoteTabsForProfile}
        />
      ) : null}

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
                  {mode === 'view' ? (
                    <input disabled className="input" value={draft.location} />
                  ) : (
                    <>
                      <select
                        className="input"
                        value={draft.location}
                        onChange={e => {
                          if (e.target.value === '__add_new__') {
                            setAddingLocation(true);
                            setNewLocationInput('');
                          } else {
                            setDraft(c => ({ ...c, location: e.target.value }));
                          }
                        }}
                      >
                        <option value="">— 选择场地 —</option>
                        {uniqueLocations.map(loc => (
                          <option key={loc} value={loc}>{loc}</option>
                        ))}
                        <option value="__add_new__" style={{ color: 'var(--accent)', fontWeight: 500 }}>+ 添加新场地</option>
                      </select>
                      {addingLocation && (
                        <input
                          className="input"
                          style={{ marginTop: 4 }}
                          value={newLocationInput}
                          onChange={e => setNewLocationInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && newLocationInput.trim()) {
                              const v = newLocationInput.trim();
                              setTempLocations(prev => prev.includes(v) ? prev : [...prev, v]);
                              setDraft(c => ({ ...c, location: v }));
                              setAddingLocation(false);
                              setNewLocationInput('');
                            }
                            if (e.key === 'Escape') {
                              setAddingLocation(false);
                              setNewLocationInput('');
                            }
                          }}
                          placeholder="输入新场地，回车确认"
                          autoFocus
                        />
                      )}
                    </>
                  )}
                </label>
                <label className="profile-panel-field">
                  <span>厂商</span>
                  {mode === 'view' ? (
                    <input disabled className="input" value={draft.manufacturer} />
                  ) : (
                    <>
                      <select
                        className="input"
                        value={draft.manufacturer}
                        onChange={e => {
                          if (e.target.value === '__add_new__') {
                            setAddingManufacturer(true);
                            setNewManufacturerInput('');
                          } else {
                            setDraft(c => ({ ...c, manufacturer: e.target.value, model: '' }));
                          }
                        }}
                      >
                        <option value="">— 选择厂商 —</option>
                        {uniqueManufacturers.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__add_new__" style={{ color: 'var(--accent)', fontWeight: 500 }}>+ 添加新厂商</option>
                      </select>
                      {addingManufacturer && (
                        <input
                          className="input"
                          style={{ marginTop: 4 }}
                          value={newManufacturerInput}
                          onChange={e => setNewManufacturerInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && newManufacturerInput.trim()) {
                              const v = newManufacturerInput.trim();
                              setTempManufacturers(prev => prev.includes(v) ? prev : [...prev, v]);
                              setDraft(c => ({ ...c, manufacturer: v, model: '' }));
                              setAddingManufacturer(false);
                              setNewManufacturerInput('');
                            }
                            if (e.key === 'Escape') {
                              setAddingManufacturer(false);
                              setNewManufacturerInput('');
                            }
                          }}
                          placeholder="输入新厂商，回车确认"
                          autoFocus
                        />
                      )}
                    </>
                  )}
                </label>
                <label className="profile-panel-field">
                  <span>型号</span>
                  {mode === 'view' ? (
                    <input disabled className="input" value={draft.model} />
                  ) : (
                    <>
                      <select
                        className="input"
                        value={draft.model}
                        onChange={e => {
                          if (e.target.value === '__add_new__') {
                            setAddingModel(true);
                            setNewModelInput('');
                          } else {
                            setDraft(c => ({ ...c, model: e.target.value }));
                          }
                        }}
                      >
                        <option value="">— {draft.manufacturer ? '选择型号' : '先选厂商'} —</option>
                        {(draft.manufacturer ? filteredModels : uniqueModels).map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__add_new__" style={{ color: 'var(--accent)', fontWeight: 500 }}>+ 添加新型号</option>
                      </select>
                      {addingModel && (
                        <input
                          className="input"
                          style={{ marginTop: 4 }}
                          value={newModelInput}
                          onChange={e => setNewModelInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && newModelInput.trim()) {
                              const v = newModelInput.trim();
                              setTempModels(prev => prev.includes(v) ? prev : [...prev, v]);
                              setDraft(c => ({ ...c, model: v }));
                              setAddingModel(false);
                              setNewModelInput('');
                            }
                            if (e.key === 'Escape') {
                              setAddingModel(false);
                              setNewModelInput('');
                            }
                          }}
                          placeholder="输入新型号，回车确认"
                          autoFocus
                        />
                      )}
                    </>
                  )}
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

      {remoteTabs.length > 0 && typeof document !== 'undefined' ? createPortal(
        <RemoteAccessOverlay
          tabs={remoteTabs}
          activeTabId={activeRemoteTabId}
          splitTabId={splitTabId}
          minimized={remoteAccessMinimized}
          onActivateTab={(tabId) => {
            setActiveRemoteTabId(tabId);
            setRemoteAccessMinimized(false);
          }}
          onCloseTab={closeRemoteTab}
          onCloseAll={closeAllRemoteTabs}
          onMinimize={() => setRemoteAccessMinimized(true)}
          onToggleSplit={toggleSplitMode}
          onSelectSplitTab={setSplitTabId}
          renderRemoteTabContent={renderRemoteTabContent}
        />,
        document.body,
      ) : null}

      {remoteTabs.length > 0 && remoteAccessMinimized ? (
        <button
          type="button"
          className="remote-access-session-dock"
          onClick={() => setRemoteAccessMinimized(false)}
        >
          <span>远程会话</span>
          <strong>{remoteTabs.length}</strong>
        </button>
      ) : null}
    </div>
  );
};

const DeviceDetailsDrawer: React.FC<{
  device: AssetDevice;
  onClose(): void;
  onEdit(): void;
  onOpenTerminal(device: AssetDevice, profile: ConnectionProfile, token: string): void;
  onOpenSftp(device: AssetDevice, profile: ConnectionProfile, session: SftpSessionReady['session']): void;
  onCloseProfileTabs(profileId: string): Promise<void>;
}> = ({ device, onClose, onEdit, onOpenTerminal, onOpenSftp, onCloseProfileTabs }) => {
  const typeLabel = DEVICE_TYPE_OPTIONS.find((item) => item.value === device.deviceType)?.label || '设备';

  return (
    <aside className="server-device-drawer" aria-label="设备详情">
      <header className="server-device-drawer-head">
        <div>
          <span className="servers-kicker">Device Detail</span>
          <h2>{device.name}</h2>
          <p>{device.ipAddress || '未填写 IP 地址'}</p>
        </div>
        <div className="server-device-drawer-actions">
          <button type="button" className="btn btn-ghost" onClick={onEdit}>
            {isReadonlyAssetDevice(device) ? <Eye size={14} /> : <Pencil size={14} />}
            {isReadonlyAssetDevice(device) ? '查看表单' : '编辑设备'}
          </button>
          <button type="button" className="scripts-upload-modal-close" onClick={onClose} aria-label="关闭设备详情">
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="server-device-drawer-body">
        <section className="server-device-drawer-summary">
          <span className={`server-device-icon ${device.deviceType}`}>
            {renderDeviceIcon(device.deviceType, 20)}
          </span>
          <div className="server-device-drawer-title">
            <span className={`server-device-source ${isReadonlyAssetDevice(device) ? 'remote' : 'local'}`}>
              {getAssetSourceLabel(device)}
            </span>
            <strong>{typeLabel}</strong>
            <span className={`server-device-status ${statusClassName[device.status]}`}>
              <i />
              {statusLabel[device.status]}
            </span>
          </div>
          <dl className="server-device-summary-list">
            <DeviceSummaryItem label="IP 地址" value={device.ipAddress} />
            <DeviceSummaryItem label="型号" value={device.model} />
            <DeviceSummaryItem label="厂商" value={device.manufacturer} />
            <DeviceSummaryItem label="设备位置" value={device.location} />
            <DeviceSummaryItem label="负责人" value={device.owner} />
            <DeviceSummaryItem label="所属单位" value={device.organization} />
            <DeviceSummaryItem label="资产 ID" value={device.assetId} />
            <DeviceSummaryItem label="序列号" value={device.serialNumber} />
          </dl>
          {device.remark ? <p className="server-device-summary-remark">{device.remark}</p> : null}
        </section>
        <section className="server-device-drawer-access">
          <RemoteAccessProfiles
            device={device}
            onOpenTerminal={onOpenTerminal}
            onOpenSftp={onOpenSftp}
            onCloseProfileTabs={onCloseProfileTabs}
          />
        </section>
      </div>
    </aside>
  );
};

const DeviceSummaryItem: React.FC<{ label: string; value?: string }> = ({ label, value }) => (
  <>
    <dt>{label}</dt>
    <dd>{value?.trim() || '-'}</dd>
  </>
);

const RemoteAccessProfiles: React.FC<{
  device: AssetDevice;
  onOpenTerminal(device: AssetDevice, profile: ConnectionProfile, token: string): void;
  onOpenSftp(device: AssetDevice, profile: ConnectionProfile, session: SftpSessionReady['session']): void;
  onCloseProfileTabs(profileId: string): Promise<void>;
}> = ({ device, onOpenTerminal, onOpenSftp, onCloseProfileTabs }) => {
  const showToast = useToastStore((state) => state.showToast);
  const [profiles, setProfiles] = React.useState<ConnectionProfile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [formOpen, setFormOpen] = React.useState(false);
  const [profileDraft, setProfileDraft] = React.useState<RemoteProfileDraft>(() => createEmptyRemoteProfile(device));
  const [saving, setSaving] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [openingTerminalId, setOpeningTerminalId] = React.useState<string | null>(null);
  const [openingSftpId, setOpeningSftpId] = React.useState<string | null>(null);
  const [connectionChecks, setConnectionChecks] = React.useState<Record<string, ConnectionCheckState>>({});

  const updateConnectionCheck = (profileId: string, updates: Partial<ConnectionCheckState>) => {
    setConnectionChecks((current) => ({
      ...current,
      [profileId]: {
        ...current[profileId],
        ...updates,
        busy: updates.busy ?? current[profileId]?.busy ?? false,
      },
    }));
  };

  const applyConnectionTestResult = (profile: ConnectionProfile, result: RemoteConnectionTestResponse) => {
    if ('protocol' in result && result.protocol === 'telnet') {
      updateConnectionCheck(profile.id, {
        result,
        hostKey: undefined,
        error: undefined,
        nextAction: undefined,
      });
      showToast(`TELNET 连接测试成功：${profile.name}`, 'success');
      return;
    }
    if ('hostKey' in result) {
      updateConnectionCheck(profile.id, {
        hostKey: result.hostKey,
        result,
        error: undefined,
        nextAction: undefined,
      });
      showToast(`SSH 连接测试成功：${profile.name}`, 'success');
      return;
    }
    if ('fingerprintSha256' in result) {
      updateConnectionCheck(profile.id, {
        hostKey: result,
        result: undefined,
        error: undefined,
      });
      if (result.code === 'HOST_KEY_MISMATCH') {
        updateConnectionCheck(profile.id, { nextAction: undefined });
        showToast(`SSH 主机密钥变化，已阻断连接：${profile.name}`, 'error');
      }
    }
  };

  const openTerminal = async (profile: ConnectionProfile) => {
    setOpeningTerminalId(profile.id);
    updateConnectionCheck(profile.id, {
      busy: true,
      error: undefined,
      nextAction: 'terminal',
    });
    try {
      const response = await createRemoteTerminalToken(profile.id, { cols: 100, rows: 30 });
      if ('token' in response) {
        updateConnectionCheck(profile.id, {
          hostKey: 'hostKey' in response ? response.hostKey : undefined,
          error: undefined,
          nextAction: undefined,
        });
        onOpenTerminal(device, profile, response.token);
        return;
      }
      updateConnectionCheck(profile.id, {
        hostKey: response,
        result: undefined,
        error: undefined,
        nextAction: response.code === 'HOST_KEY_CONFIRMATION_REQUIRED' ? 'terminal' : undefined,
      });
      if (response.code === 'HOST_KEY_MISMATCH') {
        showToast(`SSH 主机密钥变化，已阻断终端：${profile.name}`, 'error');
      }
    } catch (error) {
      const protocolLabel = getRemoteProtocolLabel(profile.protocol);
      const message = getRemoteAuthErrorMessage(error, `${protocolLabel} 终端打开失败`);
      updateConnectionCheck(profile.id, { error: message, nextAction: undefined });
      showToast(`${protocolLabel} 终端打开失败：${message}`, 'error');
    } finally {
      setOpeningTerminalId(null);
      updateConnectionCheck(profile.id, { busy: false });
    }
  };

  const openSftp = async (profile: ConnectionProfile) => {
    if (profile.protocol !== 'ssh') {
      showToast('该协议不支持 SFTP 文件管理。', 'info');
      return;
    }
    if (!profile.sftpEnabled) {
      showToast('此连接配置未启用 SFTP 预设。', 'info');
      return;
    }
    setOpeningSftpId(profile.id);
    updateConnectionCheck(profile.id, {
      busy: true,
      error: undefined,
      nextAction: 'sftp',
    });
    try {
      const response = await createSftpSession(profile.id);
      if (isSftpSessionReady(response)) {
        updateConnectionCheck(profile.id, {
          error: undefined,
          nextAction: undefined,
        });
        onOpenSftp(device, profile, response.session);
        return;
      }
      updateConnectionCheck(profile.id, {
        hostKey: response,
        result: undefined,
        error: undefined,
        nextAction: response.code === 'HOST_KEY_CONFIRMATION_REQUIRED' ? 'sftp' : undefined,
      });
      if (response.code === 'HOST_KEY_MISMATCH') {
        showToast(`SSH 主机密钥变化，已阻断 SFTP：${profile.name}`, 'error');
      } else {
        showToast(`请先确认 SSH 主机密钥：${profile.name}`, 'info');
      }
    } catch (error) {
      const message = getRemoteAuthErrorMessage(error, 'SFTP 文件浏览打开失败');
      updateConnectionCheck(profile.id, { error: message, nextAction: undefined });
      showToast(`SFTP 文件浏览打开失败：${message}`, 'error');
    } finally {
      setOpeningSftpId(null);
      updateConnectionCheck(profile.id, { busy: false });
    }
  };

  const approveHostKey = async (profile: ConnectionProfile) => {
    const check = connectionChecks[profile.id];
    const challengeToken = check?.hostKey?.challengeToken;
    if (!challengeToken) return;
    const nextAction = check.nextAction || 'test';
    updateConnectionCheck(profile.id, { busy: true, error: undefined });
    try {
      const trusted = await trustSshHostKey(profile.id, challengeToken);
      updateConnectionCheck(profile.id, { hostKey: trusted, nextAction: undefined });
      if (nextAction === 'terminal') {
        await openTerminal(profile);
        return;
      }
      if (nextAction === 'sftp') {
        await openSftp(profile);
        return;
      }
      applyConnectionTestResult(profile, await testRemoteConnection(profile.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SSH 主机密钥确认失败';
      updateConnectionCheck(profile.id, { error: message, nextAction: undefined });
      showToast(`SSH 主机密钥确认失败：${message}`, 'error');
    } finally {
      updateConnectionCheck(profile.id, { busy: false });
    }
  };

  const getHostKeyConfirmLabel = (check?: ConnectionCheckState) => {
    if (check?.nextAction === 'terminal') return '确认信任并打开终端';
    if (check?.nextAction === 'sftp') return '确认信任并打开文件';
    return '确认信任并测试';
  };

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFormOpen(false);
    setConfirmDeleteId(null);
    setOpeningTerminalId(null);
    setOpeningSftpId(null);
    setConnectionChecks({});
    setProfileDraft(createEmptyRemoteProfile(device));

    void listConnectionProfiles(device.id).then((items) => {
      if (!cancelled) setProfiles(items);
    }).catch((error) => {
      if (!cancelled) {
        showToast(error instanceof Error ? `远程配置加载失败：${error.message}` : '远程配置加载失败', 'error');
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [device.id, showToast]);

  const closeForm = () => {
    setFormOpen(false);
    setProfileDraft(createEmptyRemoteProfile(device));
  };

  const saveProfile = async () => {
    const protocol = profileDraft.protocol;
    const protocolLabel = getRemoteProtocolLabel(protocol);
    const port = Number(profileDraft.port);
    const name = profileDraft.name.trim();
    const host = profileDraft.host.trim();
    const username = profileDraft.username.trim();
    const hasPassword = profileDraft.password.length > 0;

    if (!name || !host || (protocol === 'ssh' && !username) || !Number.isInteger(port) || port < 1 || port > 65535) {
      showToast(`请填写有效的 ${protocolLabel} 配置名称、主机、端口和用户名。`, 'info');
      return;
    }
    if (protocol === 'ssh' && !profileDraft.id && !hasPassword) {
      showToast(`新建 ${protocolLabel} 配置时请输入密码。`, 'info');
      return;
    }
    const common = {
      name,
      protocol,
      host,
      port,
      username,
      sftpEnabled: protocol === 'ssh' ? profileDraft.sftpEnabled : false,
      isDefault: profileDraft.isDefault,
    };

    setSaving(true);
    try {
      if (profileDraft.id) {
        const request: ConnectionProfileUpdateRequest = {
          ...common,
          ...(hasPassword ? { authMethod: 'password' as const, password: profileDraft.password } : {}),
        };
        await updateConnectionProfile(profileDraft.id, request);
      } else {
        const request: ConnectionProfileCreateRequest = {
          ...common,
          authMethod: protocol === 'telnet' && !hasPassword ? 'none' : 'password',
          ...(hasPassword ? { password: profileDraft.password } : {}),
        };
        await createConnectionProfile(device.id, request);
      }
      setProfiles(await listConnectionProfiles(device.id));
      setConnectionChecks({});
      closeForm();
      showToast(profileDraft.id ? `${protocolLabel} 连接配置已更新` : `${protocolLabel} 连接配置已保存`, 'success');
    } catch (error) {
      setProfileDraft((current) => ({ ...current, password: '' }));
      showToast(error instanceof Error ? `${protocolLabel} 配置保存失败：${error.message}` : `${protocolLabel} 配置保存失败`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const removeProfile = async (profile: ConnectionProfile) => {
    setDeletingId(profile.id);
    try {
      await onCloseProfileTabs(profile.id);
      await deleteConnectionProfile(profile.id);
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setConnectionChecks((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      if (profileDraft.id === profile.id) closeForm();
      setConfirmDeleteId(null);
      showToast(`${getRemoteProtocolLabel(profile.protocol)} 连接配置已删除`, 'success');
    } catch (error) {
      const protocolLabel = getRemoteProtocolLabel(profile.protocol);
      showToast(error instanceof Error ? `${protocolLabel} 配置删除失败：${error.message}` : `${protocolLabel} 配置删除失败`, 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const testConnection = async (profile: ConnectionProfile) => {
    updateConnectionCheck(profile.id, {
      busy: true,
      hostKey: undefined,
      result: undefined,
      error: undefined,
      nextAction: 'test',
    });
    try {
      applyConnectionTestResult(profile, await testRemoteConnection(profile.id));
    } catch (error) {
      const message = getRemoteAuthErrorMessage(error, `${profile.protocol === 'telnet' ? 'TELNET' : 'SSH'} 连接测试失败`);
      updateConnectionCheck(profile.id, { error: message, nextAction: undefined });
      showToast(`${profile.protocol === 'telnet' ? 'TELNET' : 'SSH'} 连接测试失败：${message}`, 'error');
    } finally {
      updateConnectionCheck(profile.id, { busy: false });
    }
  };

  return (
    <section className="remote-profile-section">
      <div className="remote-profile-head">
        <div>
          <span className="remote-profile-kicker"><KeyRound size={13} /> Remote Access</span>
          <strong>远程访问</strong>
        </div>
        <button
          type="button"
          className="btn btn-ghost remote-profile-add"
          onClick={() => {
            setProfileDraft(createEmptyRemoteProfile(device));
            setFormOpen(true);
          }}
        >
          <Plus size={14} />
          新增远程配置
        </button>
      </div>
      <p className="remote-profile-note">
        密码仅保存到系统凭据库，不显示或回填。SSH 和 TELNET 终端内容不保存；SFTP 仅适用于 SSH。
      </p>

      {loading ? (
        <div className="remote-profile-empty">正在加载连接配置...</div>
      ) : profiles.length === 0 ? (
        <div className="remote-profile-empty">此设备暂无远程连接配置。</div>
      ) : (
        <div className="remote-profile-list">
          {profiles.map((profile) => {
            const check = connectionChecks[profile.id];
            const protocolLabel = getRemoteProtocolLabel(profile.protocol);
            const isTelnetProfile = profile.protocol !== 'ssh';
            const sshResult = check?.result && 'hostKey' in check.result ? check.result : null;
            const telnetResult = check?.result && 'protocol' in check.result && check.result.protocol === 'telnet' ? check.result : null;
            return (
              <div key={profile.id} className="remote-profile-card">
                <div className="remote-profile-card-main">
                  <div>
                    <div className="remote-profile-title">
                      <strong>{profile.name}</strong>
                      <span>{protocolLabel}</span>
                      {profile.isDefault ? <span>默认</span> : null}
                    </div>
                    <p>{getRemoteTargetLabel(profile)}</p>
                    <small>
                      {profile.hasPasswordCredential ? '密码已安全保存' : isTelnetProfile ? '交互式登录' : '未保存密码'} · {isTelnetProfile ? '终端连接' : profile.sftpEnabled ? 'SFTP 已预设' : '仅终端预设'}
                    </small>
                  </div>
                  <div className="remote-profile-card-actions">
                    <button type="button" className="btn btn-primary" disabled={check?.busy} onClick={() => void testConnection(profile)}>
                      {check?.busy ? '检测中...' : '测试连接'}
                    </button>
                    <button type="button" className="btn btn-primary" disabled={check?.busy} onClick={() => void openTerminal(profile)}>
                      {openingTerminalId === profile.id ? '打开中...' : '打开终端'}
                    </button>
                    {profile.protocol === 'ssh' ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={check?.busy || !(profile.protocol === 'ssh' && profile.sftpEnabled)}
                        title={profile.sftpEnabled ? undefined : '此配置未启用 SFTP 预设'}
                        onClick={() => void openSftp(profile)}
                      >
                        <FolderOpen size={14} />
                        {openingSftpId === profile.id ? '打开中...' : '打开文件'}
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-ghost" onClick={() => {
                      setConfirmDeleteId(null);
                      setProfileDraft(editRemoteProfile(profile));
                      setFormOpen(true);
                    }}>编辑</button>
                    {confirmDeleteId === profile.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost danger"
                          disabled={deletingId === profile.id}
                          onClick={() => void removeProfile(profile)}
                        >
                          {deletingId === profile.id ? '删除中...' : '确认删除'}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => setConfirmDeleteId(null)}>保留</button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-ghost danger" onClick={() => setConfirmDeleteId(profile.id)}>删除</button>
                    )}
                  </div>
                </div>
                {profile.protocol === 'ssh' && check?.hostKey?.code === 'HOST_KEY_CONFIRMATION_REQUIRED' ? (
                  <div className="remote-profile-check pending">
                    <strong>首次发现 SSH 主机密钥，请确认指纹</strong>
                    <span>{check.hostKey.host}:{check.hostKey.port} · {check.hostKey.keyType}</span>
                    <code>{check.hostKey.fingerprintSha256}</code>
                    <button type="button" className="btn btn-primary" disabled={check.busy} onClick={() => void approveHostKey(profile)}>
                      {check.busy ? '确认中...' : getHostKeyConfirmLabel(check)}
                    </button>
                  </div>
                ) : null}
                {profile.protocol === 'ssh' && check?.hostKey?.code === 'HOST_KEY_MISMATCH' ? (
                  <div className="remote-profile-check warning">
                    <strong>主机密钥已变化，连接已阻断</strong>
                    <span>受信指纹</span>
                    <code>{check.hostKey.previousFingerprintSha256}</code>
                    <span>本次发现指纹</span>
                    <code>{check.hostKey.fingerprintSha256}</code>
                  </div>
                ) : null}
                {sshResult ? (
                  <div className="remote-profile-check success">
                    <strong>认证成功</strong>
                  </div>
                ) : null}
                {telnetResult ? (
                  <div className="remote-profile-check success">
                    <strong>{telnetResult.authenticated ? '认证成功' : '连接成功'}</strong>
                  </div>
                ) : null}
                {check?.error ? <div className="remote-profile-check error">{check.error}</div> : null}
              </div>
            );
          })}
        </div>
      )}

      {formOpen ? (
        <div className="remote-profile-form">
          <div className="remote-profile-form-grid">
            <label className="profile-panel-field">
              <span>协议</span>
              <select
                className="input"
                value={profileDraft.protocol}
                onChange={(event) => {
                  const protocol = event.target.value as RemoteProfileDraft['protocol'];
                  setProfileDraft((current) => {
                    const nextPort = protocol === 'telnet'
                      ? (current.port.trim() === '22' ? '23' : current.port)
                      : (current.port.trim() === '23' ? '22' : current.port);
                    const nextName = current.id
                      ? current.name
                      : protocol === 'telnet'
                        ? current.name.replace(/\bSSH\b/gi, 'TELNET')
                        : current.name.replace(/\bTELNET\b/gi, 'SSH');
                    return {
                      ...current,
                      protocol,
                      name: nextName,
                      port: nextPort,
                      sftpEnabled: protocol === 'ssh' ? (current.protocol === 'telnet' ? true : current.sftpEnabled) : false,
                    };
                  });
                }}
              >
                <option value="ssh">SSH</option>
                <option value="telnet">TELNET</option>
              </select>
            </label>
            <label className="profile-panel-field">
              <span>配置名称</span>
              <input className="input" value={profileDraft.name} onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="profile-panel-field">
              <span>主机地址</span>
              <input className="input" value={profileDraft.host} onChange={(event) => setProfileDraft((current) => ({ ...current, host: event.target.value }))} />
            </label>
            <label className="profile-panel-field">
              <span>{getRemoteProtocolLabel(profileDraft.protocol)} 端口</span>
              <input className="input" inputMode="numeric" value={profileDraft.port} onChange={(event) => setProfileDraft((current) => ({ ...current, port: event.target.value }))} />
            </label>
            <label className="profile-panel-field">
              <span>{profileDraft.protocol === 'telnet' ? '用户名（可留空）' : '用户名'}</span>
              <input className="input" value={profileDraft.username} onChange={(event) => setProfileDraft((current) => ({ ...current, username: event.target.value }))} />
            </label>
            <label className="profile-panel-field remote-profile-password">
              <span>
                {profileDraft.protocol === 'telnet'
                  ? profileDraft.id ? '新密码（可留空，留空不修改）' : '密码（可留空，打开终端后手动输入）'
                  : profileDraft.id ? '新密码（留空不修改）' : '密码'}
              </span>
              <input
                className="input remote-profile-secret-input"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                value={profileDraft.password}
                onChange={(event) => setProfileDraft((current) => ({ ...current, password: event.target.value }))}
              />
            </label>
          </div>
          <div className="remote-profile-options">
            {profileDraft.protocol === 'ssh' ? (
              <label>
                <input type="checkbox" checked={profileDraft.sftpEnabled} onChange={(event) => setProfileDraft((current) => ({ ...current, sftpEnabled: event.target.checked }))} />
                预设 SFTP 能力
              </label>
            ) : null}
            <label>
              <input type="checkbox" checked={profileDraft.isDefault} onChange={(event) => setProfileDraft((current) => ({ ...current, isDefault: event.target.checked }))} />
              设为默认连接
            </label>
          </div>
          <div className="remote-profile-form-actions">
            <button type="button" className="btn btn-ghost" onClick={closeForm}>取消</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveProfile()}>
              {saving ? '保存中...' : `保存 ${getRemoteProtocolLabel(profileDraft.protocol)} 配置`}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

const getRemoteAccessTabLabel = (tab: RemoteAccessTab) => {
  const protocol = tab.kind === 'sftp' ? 'SFTP' : getRemoteProtocolLabel(tab.protocol);
  return `${tab.host} (${protocol})`;
};

const RemoteAccessOverlay: React.FC<{
  tabs: RemoteAccessTab[];
  activeTabId: string | null;
  splitTabId: string | null;
  minimized: boolean;
  onActivateTab(tabId: string): void;
  onCloseTab(tabId: string): void;
  onCloseAll(): void;
  onMinimize(): void;
  onToggleSplit(): void;
  onSelectSplitTab(tabId: string | null): void;
  renderRemoteTabContent(tab: RemoteAccessTab, visible: boolean, active: boolean): React.ReactNode;
}> = ({
  tabs,
  activeTabId,
  splitTabId,
  minimized,
  onActivateTab,
  onCloseTab,
  onCloseAll,
  onMinimize,
  onToggleSplit,
  onSelectSplitTab,
  renderRemoteTabContent,
}) => {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;
  const splitOptions = activeTab ? tabs.filter((tab) => tab.id !== activeTab.id) : [];
  const splitTab = splitOptions.find((tab) => tab.id === splitTabId) || null;
  const visibleIds = new Set([activeTab?.id, splitTab?.id].filter(Boolean));

  return (
    <div className={`remote-access-overlay-backdrop${minimized ? ' minimized' : ''}`}>
      <section className="remote-access-overlay" aria-label="远程访问工作区">
        <header className="remote-access-overlay-head">
          <div className="remote-access-tabbar" role="tablist" aria-label="远程访问会话">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`remote-access-tab${tab.id === activeTab?.id ? ' active' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeTab?.id}
                  className="remote-access-tab-main"
                  onClick={() => onActivateTab(tab.id)}
                >
                  <span>{getRemoteAccessTabLabel(tab)}</span>
                </button>
                <button
                  type="button"
                  className="remote-access-tab-close"
                  aria-label={`关闭 ${getRemoteAccessTabLabel(tab)}`}
                  onClick={() => onCloseTab(tab.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="remote-access-overlay-actions">
            {splitOptions.length > 0 ? (
              <>
                <button
                  type="button"
                  className="remote-access-icon-btn"
                  onClick={onToggleSplit}
                  aria-label={splitTab ? '关闭左右分屏' : '开启左右分屏'}
                  title={splitTab ? '关闭左右分屏' : '开启左右分屏'}
                >
                  <Columns2 size={16} />
                </button>
                {splitTab ? (
                  <select
                    className="input remote-access-split-select"
                    value={splitTab.id}
                    onChange={(event) => onSelectSplitTab(event.target.value || null)}
                    aria-label="选择右侧分屏会话"
                  >
                    {splitOptions.map((tab) => (
                      <option key={tab.id} value={tab.id}>{getRemoteAccessTabLabel(tab)}</option>
                    ))}
                  </select>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              className="remote-access-icon-btn"
              onClick={onMinimize}
              aria-label="最小化远程工作区"
              title="最小化远程工作区"
            >
              <Minimize2 size={16} />
            </button>
            <button
              type="button"
              className="remote-access-icon-btn"
              onClick={onCloseAll}
              aria-label="关闭全部远程会话"
              title="关闭全部远程会话"
            >
              <XCircle size={16} />
            </button>
          </div>
        </header>
        <main className={`remote-access-content${splitTab ? ' remote-access-split' : ''}`}>
          {tabs.map((tab) => {
            const isVisible = visibleIds.has(tab.id);
            const isActive = tab.id === activeTab?.id;
            const role = tab.id === activeTab?.id ? ' primary' : tab.id === splitTab?.id ? ' secondary' : '';
            return (
              <section
                key={tab.id}
                className={`remote-access-pane${role}${isVisible ? ' visible' : ' hidden'}`}
                aria-hidden={!isVisible}
              >
                {renderRemoteTabContent(tab, isVisible && !minimized, isActive && !minimized)}
              </section>
            );
          })}
        </main>
      </section>
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
