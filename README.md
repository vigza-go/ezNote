# 轻记 - 轻量协同笔记

基于 Node.js + JSON 文件存储的轻量级协同图文笔记应用。
<img width="2880" height="1509" alt="image" src="https://github.com/user-attachments/assets/45a2ffc4-fa15-4cd8-a340-a3571cf68b82" />
<img width="2880" height="1488" alt="image" src="https://github.com/user-attachments/assets/77ea8db4-7a46-49d7-9bf4-a1ee7e3a4dec" />

## 特性

- **轻量**：原生 Node.js，无数据库依赖，数据以 JSON 文件存储
- **协同**：基于 Yjs CRDT 的实时协同编辑，支持多人同时编辑
- **图文**：支持粘贴/拖拽上传图片，图片独立存储
- **美观**：现代化 UI，支持暗色模式
- **备份**：支持webdav自动备份
- **日报**：独立的每日清单模块，按天记录 + 多日总览表格，与笔记系统互不干扰

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
├── yjs/       # Yjs 协同状态文件
└── daily/     # 日报，一天一个文件，如 2026-11-08.json
```

日报文件格式（只有内容，没有 CRDT）：

```json
{
  "date": "2026-11-08",
  "sections": [
    { "key": "done",  "title": "今日完成", "items": [{ "text": "修 gkd 脚本", "checked": true }] },
    { "key": "plan",  "title": "明日计划", "items": [] },
    { "key": "issue", "title": "问题与思考", "items": [] }
  ],
  "updatedAt": "2026-11-08T08:00:00.000Z"
}
```

三栏全空时不落盘（自动删文件），所以目录里只有真正记录过的日期。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/notes | 获取所有笔记 |
| POST | /api/notes | 创建笔记 |
| GET | /api/notes/:id | 获取单个笔记 |
| PUT | /api/notes/:id | 更新笔记 |
| DELETE | /api/notes/:id | 删除笔记 |
| POST | /api/upload | 上传图片 |
| GET | /api/daily/:date | 读取某天日报，不存在返回空骨架 |
| PUT | /api/daily/:date | 保存某天日报 |
| DELETE | /api/daily/:date | 删除某天日报 |
| GET | /api/daily?to=&days= | 区间查询，给总览表用（days 默认 14，上限 366） |
| GET | /api/daily/dates | 已有记录的日期列表 |

## 技术栈

- **后端**：Node.js, y-websocket, yjs
- **前端**：Tiptap, ProseMirror, rollup（日报模块为原生 DOM，不依赖 Tiptap）
- **存储**：JSON 文件 + 本地图片目录

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务器端口 |
| AUTH_USER | vigza | 登录用户名 |
| AUTH_PASS | （必填） | 登录密码，未设置则无法登录 |
| AUTH_TOKEN | （必填） | API 鉴权 token |
| WEBDAV_URL | （空） | WebDAV 备份地址，留空则跳过备份 |
| WEBDAV_USER | （空） | WebDAV 用户名 |
| WEBDAV_PASSWORD | （空） | WebDAV 密码 |
| BACKUP_NAME | ezNote-backup | 备份文件名 |
| ENABLE_BACKUP | true | 是否启用备份 |

**本地开发**：复制 `.env.example` 为 `.env` 并填写（`.env` 已被 git 忽略），`npm start` / `npm run dev` 会自动读取。

**生产部署**：真实值写在 `ecosystem.config.js` 的 `env` 里（该文件同样不入库），用
`pm2 restart ecosystem.config.js --update-env` 重启才会生效。
