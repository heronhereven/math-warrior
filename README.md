# math-warrior

一个带游戏化成长反馈的数学学习记录页，现在已经拆成两套真实界面：

- 泡面侠前台：学习圆环、证明上传、签到月历、成长足迹、账号设置
- 小和后台：待审核证明队列、泡面侠分类、个体成长仪表盘
- Python 后端：注册 / 登录 / 会话 / SQLite 持久化 / 审核流转
- 审核权威结算：学习证明通过后才会点亮圆环、经验、等级和奖励

## 本地运行

```bash
python server.py
```

默认会启动在 `http://127.0.0.1:8000`。

管理员账号可以通过参数自定义：

```bash
python server.py --port 9000 --admin-user root --admin-password strongpass123
```

## 测试

```bash
python -m unittest tests.test_server
```

## 文件说明

- `index.html`: 真实静态客户端入口，直接包含泡面侠前台和小和后台壳子
- `server.py`: Python 后端，负责静态服务、认证、会话、审核和 SQLite
- `app-client.js`: 前后台交互逻辑、审核流程、签到和动画
- `app-extra.css`: 统一视觉样式和交互动效
- `tests/test_server.py`: 后端接口测试
