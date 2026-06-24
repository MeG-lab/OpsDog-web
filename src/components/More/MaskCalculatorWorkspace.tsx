import React from 'react';
import ipaddr from 'ipaddr.js';
import { Calculator, Network, RotateCcw } from 'lucide-react';

const DEFAULT_CIDR = '192.168.1.10/24';

type SubnetResult = {
  cidr: string;
  ipAddress: string;
  prefixLength: number;
  subnetMask: string;
  networkAddress: string;
  broadcastAddress: string;
  hostRange: string;
  usableHosts: string;
};

const numberFormatter = new Intl.NumberFormat('zh-CN');

const toUint32 = (octets: number[]) =>
  octets.reduce((acc, octet) => ((acc * 256) + octet) >>> 0, 0);

const uint32ToIp = (value: number) =>
  [24, 16, 8, 0].map((shift) => String((value >>> shift) & 255)).join('.');

const calculateSubnet = (rawValue: string): SubnetResult => {
  const value = rawValue.trim();
  const match = value.match(/^([^/]+)\/(\d{1,2})$/);
  if (!match) {
    throw new Error('请输入 IPv4 CIDR，例如 192.168.1.10/24');
  }

  const [, rawIp, rawPrefix] = match;
  const ipText = rawIp.trim();
  const prefixLength = Number(rawPrefix);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error('CIDR 前缀需要在 0 到 32 之间');
  }
  if (!ipaddr.IPv4.isValid(ipText)) {
    throw new Error('请输入有效的 IPv4 地址');
  }

  const address = ipaddr.IPv4.parse(ipText);
  const cidr = `${address.toString()}/${prefixLength}`;
  const networkAddress = ipaddr.IPv4.networkAddressFromCIDR(cidr).toString();
  const broadcastAddress = ipaddr.IPv4.broadcastAddressFromCIDR(cidr).toString();
  const subnetMask = ipaddr.IPv4.subnetMaskFromPrefixLength(prefixLength).toString();
  const networkInt = toUint32(ipaddr.IPv4.parse(networkAddress).octets);
  const broadcastInt = toUint32(ipaddr.IPv4.parse(broadcastAddress).octets);
  const hostBits = 32 - prefixLength;
  const usableHostCount = prefixLength === 32
    ? 1
    : prefixLength === 31
      ? 2
      : Math.max(0, (2 ** hostBits) - 2);
  const firstHost = prefixLength >= 31 ? networkInt : (networkInt + 1) >>> 0;
  const lastHost = prefixLength >= 31 ? broadcastInt : (broadcastInt - 1) >>> 0;

  return {
    cidr,
    ipAddress: address.toString(),
    prefixLength,
    subnetMask,
    networkAddress,
    broadcastAddress,
    hostRange: `${uint32ToIp(firstHost)} - ${uint32ToIp(lastHost)}`,
    usableHosts: numberFormatter.format(usableHostCount),
  };
};

const MaskCalculatorWorkspace: React.FC = () => {
  const [cidrInput, setCidrInput] = React.useState(DEFAULT_CIDR);
  const calculation = React.useMemo(() => {
    try {
      return { result: calculateSubnet(cidrInput), error: null };
    } catch (error) {
      return {
        result: null,
        error: error instanceof Error ? error.message : 'CIDR 解析失败',
      };
    }
  }, [cidrInput]);

  const resultItems = calculation.result
    ? [
        { label: '输入地址', value: calculation.result.ipAddress },
        { label: 'CIDR', value: `/${calculation.result.prefixLength}` },
        { label: '子网掩码', value: calculation.result.subnetMask },
        { label: '网络地址', value: calculation.result.networkAddress },
        { label: '广播地址', value: calculation.result.broadcastAddress },
        { label: '可用主机范围', value: calculation.result.hostRange },
        { label: '可用主机数', value: calculation.result.usableHosts },
      ]
    : [];

  return (
    <div className="more-workspace">
      <section className="mask-calculator-shell">
        <div className="mask-calculator-head">
          <div className="mask-calculator-icon">
            <Calculator size={22} />
          </div>
          <div>
            <span>更多功能</span>
            <h1>掩码计算器</h1>
          </div>
        </div>

        <div className="mask-calculator-grid">
          <form className="mask-calculator-form" onSubmit={(event) => event.preventDefault()}>
            <label className="profile-panel-field">
              <span>IPv4 / CIDR</span>
              <input
                className="input"
                value={cidrInput}
                onChange={(event) => setCidrInput(event.target.value)}
                placeholder="192.168.1.10/24"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {calculation.error ? (
              <div className="mask-calculator-error" role="alert">
                {calculation.error}
              </div>
            ) : null}
            <div className="mask-calculator-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setCidrInput(DEFAULT_CIDR)}
                title="重置"
              >
                <RotateCcw size={14} />
                <span>重置</span>
              </button>
            </div>
          </form>

          <div className="mask-calculator-summary">
            <div className="mask-calculator-summary-head">
              <Network size={16} />
              <span>{calculation.result?.cidr ?? '等待输入'}</span>
            </div>
            <div className="mask-result-grid">
              {resultItems.map((item) => (
                <div key={item.label} className="mask-result-card">
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default MaskCalculatorWorkspace;
