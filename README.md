# Copilot Desktop

基于 [GitHub Copilot SDK](https://github.com/github/copilot-sdk) 的桌面编码助手，类似 Claude Cowork / Codex Desktop。

![Electron](https://img.shields.io/badge/Electron-35-47848F?logo=electron)
![Copilot SDK](https://img.shields.io/badge/Copilot_SDK-latest-blue?logo=github)

## 功能

- 💬 **流式对话** — 实时显示 Copilot 响应
- 🔧 **工具执行可视化** — 显示文件编辑、命令执行等工具调用
- 📂 **项目感知** — 选择工作目录，Copilot 可以读写项目文件
- 🤖 **多模型支持** — Claude Sonnet 4.5、GPT-5 等
- 🎨 **GitHub Dark 主题** — 熟悉的暗色界面

## 前置要求

- [GitHub Copilot CLI](https://github.com/features/copilot/cli) 已安装并登录
- 有效的 Copilot 订阅
- Node.js 18+

## 快速开始

```bash
# 安装依赖
npm install

# 构建并运行
npm start

# 开发模式（自动打开 DevTools）
npm run dev
```

## 架构

```
Renderer (HTML/CSS/JS)
       ↕ IPC (contextBridge)
Main Process (Electron + TypeScript)
       ↕ JSON-RPC
Copilot CLI (server mode, auto-managed)
```

- **Main Process** (`src/main.ts`): Electron 主进程，管理 CopilotClient 和会话
- **Preload** (`src/preload.ts`): IPC 桥接，通过 contextBridge 暴露 API
- **Renderer** (`src/renderer/`): 聊天界面，纯 HTML/CSS/JS

## 项目结构

```
copilot-desktop/
├── package.json
├── tsconfig.json
├── scripts/build.mjs        # esbuild 构建脚本
├── src/
│   ├── main.ts              # Electron 主进程 + Copilot SDK
│   ├── preload.ts           # IPC 桥接
│   └── renderer/
│       ├── index.html        # 主窗口
│       ├── styles.css        # 聊天 UI 样式
│       └── app.js            # 渲染进程逻辑
└── README.md
```

## 许可

MIT
