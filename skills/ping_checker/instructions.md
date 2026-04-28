# Ping Checker Skill

这个 Skill 用来告诉模型何时调用项目脚本 `scripts/instant/test_ping.py`，并说明它依赖 `scripts/instant/ping.txt` 作为待检测目标列表。

## 适用场景

- 需要快速检查目标 IP 是否可达
- 需要验证基础网络连通性
- 需要批量测试一个或多个固定目标

## 使用方式

1. 打开项目目录下的 `scripts/instant/ping.txt`
2. 按 `名称 IP` 的格式填写每一行，例如：

```txt
谷歌 8.8.8.8
网关 192.168.1.1
```

3. 在对话里输入类似下面的需求：
   - 帮我做一次 ping 测试
   - 检查网络是否正常
   - 根据 ping.txt 测一下连通性
   - 执行 ping_checker

## 给模型的约束

- 这个 Skill 负责说明脚本位置和使用方法，不负责承载脚本本体
- 真正执行的 Python 文件位于项目 `scripts/instant/test_ping.py`
- 输入文件位于项目 `scripts/instant/ping.txt`
- 当用户明确要求执行 ping 检测时，应调用本地即时任务执行该脚本

## 执行结果

脚本会输出每个目标的测试结果，格式类似：

```txt
测试成功 时间：2026年04月23日 谷歌 8.8.8.8
```

如果 `ping.txt` 不存在、格式不正确，或者系统里没有 `ping` 命令，脚本会直接输出错误信息。
