我的需求 :简单 美观 轻量 图文 协同 储存 性能的web文本编辑器，能部署到私人服务器上。MiniMax 写的那套原生 Node.js + JSON 文件存储的骨架。
为了保住 150MB 的红线，同时解决图文、协同和性能，我们需要对 MiniMax 的代码做一次“引擎级”的微调改造。
以下是严谨的施行计划，分四个阶段：
阶段一：底层存储重构（解决图文与性能的矛盾）
目标：图文分离存储，消除大文件 I/O 阻塞。
具体做法：
保留 JSON 存文字：data/notes/xxx.json 只存 title 和 content（纯文本或轻量 Markdown）。
新增本地图片目录：创建 data/images/ 目录。
极简图片上传 API：在原有 HTTP 服务上加一个 POST /api/upload 接口。接收到前端传来的图片 Buffer 后，用 crypto.randomBytes 生成短 ID（如 a1b2.jpg），直接写入 data/images/，并返回 URL /images/a1b2.jpg。
静态资源托管：在 Node.js 里加一行路由拦截，当请求路径是 /images/xxx 时，用 fs.createReadStream 配合 stream.pipe(res) 返回图片。（零内存占用，比 Base64 性能高百倍）。
阶段二：协同引擎植入（替换 Last-Write-Wins）
目标：支持多人实时同屏，光标不冲突。
具体做法：
引入 y-websocket 包。
修改 Node.js 的 http.createServer，将其作为参数传入 WebSocket 服务，实现 HTTP 与 WS 共享同一端口（不增加额外端口暴露）。
后端只做纯粹的“消息路由器”：按 noteId 分发 Yjs 的同步增量，不在服务端内存里常驻 Yjs 文档。
后端监听 Yjs 的 update 事件，每 2 秒防抖一次，将当前文档的最新纯文本状态写回 JSON 文件（接阶段一的存储）。
阶段三：前端编辑器替换（解决美观与协同感知）
目标：现代化的 UI，支持图片插入，显示他人光标。
具体做法：
引入 Tiptap（基于 ProseMirror）和它的 Yjs 协同扩展包。
废弃 <textarea>，将 Tiptap 渲染到原本的 #noteContent 容器中。
图片交互：监听粘贴事件拦截图片 -> 调用阶段一的 /api/upload 接口 -> 拿到返回的 URL -> 执行 Tiptap 的 editor.chain().focus().setImage({ src: url }).run()。
UI 适配：写一份极简的 CSS，实现类似 Notion 的悬浮工具栏、暗色模式。
阶段四：性能兜底与加固
目标：防止极端情况下的内存泄漏与崩溃。
具体做法：
懒加载机制：只有当用户点击某篇笔记时，才建立该笔记的 WebSocket 连接和 Yjs 实例；切走时断开并销毁实例。保证不管有多少篇笔记，前端内存恒定。
大文件拦截：在 /api/upload 接口里，严格限制请求体大小（如 3MB），超限直接 413 拒绝，保护 150MB 服务器不被撑爆。
Zlib 压缩：Node.js 返回 JSON 和前端请求时，开启 zlib 压缩，减少网络带宽占用。
改造后的架构图与性能指标
[浏览器 A (Tiptap+Yjs)] ←── WebSocket ──→ [Node.js 单进程] ←── WebSocket ──→ [浏览器 B]
           │                                     │
           │ POST /api/upload                    │ fs.readFile (Stream)
           ↓                                     ↓
      [图片 Buffer] ──────────────────────→ [data/images/a1b2.jpg]
                                             │ (每2秒防抖写入)
                                             ↓
                                       [data/notes/xxx.json]
最终性能预估：
启动内存：~30MB (Node.js)
运行内存：~50MB - 70MB (即使 5 个人同时在线，因为服务端不做文档计算)
Docker 镜像大小：如果用 Alpine 版本的 Node 打包，约 80MB - 100MB。
图片加载性能：本地磁盘 Stream 直出，延迟 < 5ms。
