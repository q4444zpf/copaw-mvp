# copaw-mvp-server

## 启动

```bash
npm install
cp .env.example .env
npm run dev
```

## 环境变量

- `COPAW_MESSAGE_URL`: CoPaw 消息入口 URL（默认 `http://localhost:8088/api/agent/process`）
- `COPAW_API_MODE`: `agent_process`（默认）或 `channel_webhook`
- `COPAW_DEFAULT_AGENT`: 可选，默认 CoPaw Agent（会放到 `X-Agent-Id` 头）
- `COPAW_API_KEY`: 可选
- `COPAW_API_KEY_HEADER`: 默认 `Authorization`
- `COPAW_API_KEY_PREFIX`: 默认 `Bearer`
- `COPAW_WORKSPACE_ROOT`: 可选。文件映射根目录（默认 `~/.copaw/workspaces`）
- `COPAW_FILE_SEARCH_MAX_DEPTH`: 可选。文件名搜索目录深度（默认 `8`）
- `COPAW_FILE_SEARCH_MAX_ENTRIES`: 可选。文件名搜索最大扫描条目（默认 `20000`）
- `ADMIN_TOKEN`: 可选。配置后可启用只读排查接口 `GET /api/admin/sessions`

## MVP 鉴权方式

请求头传入：

- `x-tenant-id`
- `x-user-id`

生产环境建议改为 JWT，并在服务端解析出 tenant/user。

## 调试示例

```bash
curl -X POST http://localhost:8787/api/chat/session \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-a" \
  -H "x-user-id: u-1001" \
  -d "{\"channel\":\"web-chat\"}"
```

```bash
curl -X POST http://localhost:8787/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-a" \
  -H "x-user-id: u-1001" \
  -d "{\"channel\":\"web-chat\",\"message\":\"你好\"}"
```

```bash
curl -N -X POST http://localhost:8787/api/chat/stream \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-a" \
  -H "x-user-id: u-1001" \
  -d "{\"channel\":\"web-chat\",\"message\":\"请逐步思考并回答\"}"
```

```bash
curl "http://localhost:8787/api/admin/sessions?tenant_id=tenant-a&limit=20" \
  -H "x-admin-token: <ADMIN_TOKEN>"
```

```bash
curl "http://localhost:8787/api/files/content?name=frequency_chart.png"
```
