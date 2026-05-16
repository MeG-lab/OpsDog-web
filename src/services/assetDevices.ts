import type { AssetDevice } from '../types';
import type { AssetDeviceQuery, RemoteAssetDeviceRecord } from './contracts';
import { listAssetDevices } from './runtime';

const mapAssetType = (assetType?: number): AssetDevice['deviceType'] => {
  if (assetType === 1) return 'server';
  if (assetType === 2) return 'storage';
  if (assetType === 3) return 'security';
  return 'network';
};

const mapUseStatus = (useStatus?: number): AssetDevice['status'] => {
  if (useStatus === 1 || useStatus === 10) return 'healthy';
  if (useStatus === 13) return 'attention';
  return 'critical';
};

export const mapRemoteAssetToDevice = (item: RemoteAssetDeviceRecord): AssetDevice => {
  const now = new Date().toISOString();
  return {
    id: String(item.id),
    name: item.name || '',
    assetId: String(item.id || ''),
    ipAddress: item.ipAddr || '',
    deviceType: mapAssetType(item.assetType),
    status: mapUseStatus(item.useStatus),
    location: item.jfName || '',
    model: item.deviceModel || '',
    manufacturer: item.deviceBrand || '',
    serialNumber: item.productSn || '',
    organization: item.customerName || '',
    owner: item.manageUser || '',
    remark: item.providerName || '',
    createdAt: now,
    updatedAt: now,
  };
};

export const fetchAssetDevicesExample = async (query: AssetDeviceQuery = {}): Promise<AssetDevice[]> => {
  const response = await listAssetDevices(query);
  return response.items;
};
