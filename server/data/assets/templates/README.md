初始化模板目录。

用途：
- 当你想重置资产数据时，先把 `server/data/assets` 下正在使用的 JSON 文件移走或备份。
- 再把本目录里的模板文件复制回上一层目录。

建议重置的文件：
- `device.remote.json`
- `devices.local.json`
- `device.meta.json`
- `device.status.json`
- `device.merged.json`

说明：
- `device.remote.json`：远端资产空模板
- `devices.local.json`：本地设备空模板
- `device.meta.json`：平台元数据空模板
- `device.status.json`：检测状态空模板
- `device.merged.json`：统一结果空模板

注意：
- `device.merged.json` 是派生文件。即使不手工复制，后端启动后也会自动重建。
- 如果你复制了空模板，后端启动后会根据当时的 `device.remote.json`、`devices.local.json`、`device.meta.json`、`device.status.json` 自动重新生成 merged。
