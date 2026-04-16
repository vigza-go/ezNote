# 轻记 - 轻量协同笔记

基于 Node.js + JSON 文件存储的轻量级协同图文笔记应用。

## 特性

- **轻量**：原生 Node.js，无数据库依赖，数据以 JSON 文件存储
- **协同**：基于 Yjs CRDT 的实时协同编辑，支持多人同时编辑
- **图文**：支持粘贴/拖拽上传图片，图片独立存储
- **美观**：现代化 UI，支持暗色模式
- **可部署**：可部署到私人服务器，Docker 友好

## 快速开始

```bash
npm install
npm run build
npm start
```

访问 http://localhost:3000

## 开发模式

```bash
npm run dev
```

## 数据目录

```
data/
├── notes/     # 笔记 JSON 文件
├── images/    # 上传的图片
└── yjs/      # Yjs 协同状态文件
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/notes | 获取所有笔记 |
| POST | /api/notes | 创建笔记 |
| GET | /api/notes/:id | 获取单个笔记 |
| PUT | /api/notes/:id | 更新笔记 |
| DELETE | /api/notes/:id | 删除笔记 |
| POST | /api/upload | 上传图片 |

## 技术栈

- **后端**：Node.js, y-websocket, yjs
- **前端**：Tiptap, ProseMirror, esbuild
- **存储**：JSON 文件 + 本地图片目录

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务器端口 |
