# math-warrior

一个带游戏化成长反馈的数学学习记录页，现在已经拆成两套真实界面：

- 泡面侠前台：学习圆环、证明上传、签到月历、成长足迹、账号设置
- 小和后台：待审核证明队列、泡面侠分类、个体成长仪表盘
- Python 后端：注册 / 登录 / 会话 / SQLite 持久化 / 审核流转
- 审核权威结算：学习证明通过后才会点亮圆环、经验、等级和奖励
- GitHub 同步桥：用户端把提交推到私有仓库，小和端定时拉取并回写审核结果

## 本地运行

```bash
python server.py
```

默认会启动在 `http://127.0.0.1:8000`。

管理员账号可以通过参数自定义：

```bash
python server.py --port 9000 --admin-user root --admin-password strongpass123
```

桌面启动器：

```bash
python gui_app.py
```

它会自动启动本地服务并打开页面，数据库和上传文件会写入用户本地数据目录。

小和管理端启动器：

```bash
python gui_admin_app.py
```

它会自动启动小和本地工作台，并在配置好 GitHub 私有仓库后后台拉取提交、回写审核。

## GitHub 同步

如果不想正式部署共享后端，可以先用一个**私有 GitHub 仓库**做分钟级同步中转。

建议：

- 这个同步仓库由小和持有
- 你这边和小和那边都用各自的 token 访问同一个私有仓库
- 轮询间隔设成 300 秒就能满足“5 分钟内同步”的要求

桌面端配置文件：

- 泡面侠端：`MathQuestDesktop/github-sync.json`
- 小和端：`MathQuestXiaohe/github-sync-admin.json`

这两个文件都会在首次启动桌面端时自动生成模板。把 `enabled` 改成 `true`，再填好 `owner / repo / token` 即可。

基础命令：

```bash
python github_sync_client.py --owner xiaohe-account --repo math-quest-sync --token YOUR_CLIENT_TOKEN --once
python github_sync_server.py --owner xiaohe-account --repo math-quest-sync --token YOUR_ADMIN_TOKEN --once
```

持续轮询：

```bash
python github_sync_client.py --owner xiaohe-account --repo math-quest-sync --token YOUR_CLIENT_TOKEN --interval 300
python github_sync_server.py --owner xiaohe-account --repo math-quest-sync --token YOUR_ADMIN_TOKEN --interval 300
```

当前同步内容：

- `state-cache/<username>.json`
- `submissions/<username>/<submission_id>.json`
- `proofs/<username>/<submission_id>.<ext>`
- `reviews/<username>/<submission_id>.json`

现在这套基础架构已经能做两件事：

- 用户端把本地状态、学习证明和凭证推到 GitHub，并拉取小和的审核回执
- 小和端把 GitHub 上的提交导入本地后台数据库，并把审核结果写回 GitHub

这套方案适合：

- 1 位泡面侠 + 1 位管理员
- 分钟级同步
- 图片/PDF 体积不太大的凭证

它不适合：

- 高频多人并发
- 特别大的凭证文件
- 强实时场景

## 测试

```bash
python -m unittest tests.test_server
```

## 文件说明

- `index.html`: 真实静态客户端入口，直接包含泡面侠前台和小和后台壳子
- `server.py`: Python 后端，负责静态服务、认证、会话、审核和 SQLite
- `app-client.js`: 前后台交互逻辑、审核流程、签到和动画
- `app-extra.css`: 统一视觉样式和交互动效
- `gui_app.py`: 桌面启动器，自动拉起本地服务并打开页面
- `gui_admin_app.py`: 小和专用桌面启动器，自动拉起本地后台并处理 GitHub 同步
- `desktop_runtime.py`: 桌面端公用运行时和定时同步辅助逻辑
- `github_sync_client.py`: 用户端 GitHub 同步脚本，负责推状态/提交、拉审核
- `github_sync_server.py`: 小和端 GitHub 同步脚本，负责拉提交、回写审核
- `tests/test_server.py`: 后端接口测试
