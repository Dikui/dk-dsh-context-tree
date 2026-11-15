# dk-dsh-context-tree

按条回退对话：在 DeepSeek Harness 里点某条用户消息旁的图标，会话就退回到那条消息之前，原文本回到输入框，改完直接发。

回退是**原地**发生的，不新建会话、不丢原对话：模型上下文从那条消息起被截断，屏幕上对应的消息也一起收起。日志永远只追加，插件只追加一条带 `surfaceOp: replace` 的 `user/message` 来遮蔽要退掉的那段。

## 用法

1. 悬停在任意一条用户消息上，在时间与复制按钮那一行最右侧点回退图标。
2. 该消息及其之后的内容立刻从对话里收起。
3. 这条消息的原文出现在输入框里。
4. 改完发送，对话从这条消息处继续。

刷新页面、重新打开会话、换一个窗口，收起状态都会从日志重建，不会重新冒出旧内容。

## 行为与边界

- 只回退**对话上下文**。文件改动、命令副作用、后台任务不会撤销。
- goal、todo 等领域状态不会跟着回退。DSH 的消息遮蔽语义就是只改模型读到的内容。
- 只收起本插件执行的回退；DSH 自己的系统消息替换、上下文压缩（`compact-checkpoint`）和重放 `tool/result` 不会被误判成回退。
- 遮罩按会话隔离：切换会话时清空，不会把上一个会话的 turn 号或消息 id 带到新会话。
- 正在生成回复时拒绝回退（`session-busy`），避免和进行中的请求抢同一个 surface。
- 会话必须由当前 Host 持有（`session-not-active` 会直接提示）。冷会话不自动改成分支。
- 回退本身不可撤销；要继续，再回退到更靠前的一条消息即可。

## 安装

```bash
# 在 DSH 里安装本地 bundle
plugin_manager install_bundle target=file:/path/to/dk-dsh-context-tree
```

安装后刷新页面生效。Host 侧改动需要重载插件（禁用再启用）。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：`truncate`（执行原地回退）与 `cut`（只读查询已有回退范围）两条同源 JSON 路由 |
| `client.js` | Client 半边：消息行图标、遮罩、`cut` 重建；`createRowMask` 在 `dc:mask:*` 标记之间，测试逐字加载 |
| `src/plan.js` | 纯函数：定位消息、判断进行中的轮次、折叠回退范围、构造回退消息 |
| `test/` | `node:test` 单测：规划器、路由、遮罩工厂 |

## 开发

```bash
npm run check   # node --check ×3 + node --test
```

没有构建步骤：`client.js` 由模块加载器按普通脚本读取，只允许 `require('react')`。
