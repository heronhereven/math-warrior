# math-warrior

一个带 RPG 风格任务面板的数学学习记录页。

现在仓库额外提供了一套本地可运行的后端：

- 注册 / 登录 / 退出登录
- SQLite 持久化保存每个账号的任务数据
- 管理员账号查看所有用户的学习摘要和最近记录
- 保留原来的单文件前端交互，直接跑 `server.py` 时自动注入登录和管理层

## 本地运行

```bash
python server.py
```

默认会启动在 `http://127.0.0.1:8000`。

管理员账号也可以自定义：

```bash
python server.py --port 9000 --admin-user root --admin-password strongpass123
```

## 测试

```bash
python -m unittest tests.test_server
```

## 文件说明

- `index.html`: 原始前端页面
- `server.py`: Python 后端，负责静态服务、认证、会话和 SQLite
- `app-client.js`: 登录态、后端同步、管理员总览的前端增强脚本
- `app-extra.css`: 登录和管理员界面的补充样式
- `tests/test_server.py`: 后端接口测试
