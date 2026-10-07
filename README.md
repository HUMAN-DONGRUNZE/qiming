# 青少年赛事信息聚合平台

项目重构版本，基于Vue3和FastAPI的现代化赛事信息聚合平台。

## 项目结构

```
Qiming/
├── frontend/                 # 前端项目 (Vue3 + Element Plus)
│   ├── src/
│   │   ├── views/           # 页面组件
│   │   │   ├── Home.vue     # 首页
│   │   │   ├── CompetitionList.vue  # 赛事列表页
│   │   │   ├── CompetitionDetail.vue  # 赛事详情页
│   │   │   └── admin/       # 管理后台页面
│   │   │       ├── AdminLogin.vue
│   │   │       ├── AdminDashboard.vue
│   │   │       └── CompetitionManagement.vue
│   │   ├── api/             # API接口
│   │   ├── router/          # 路由配置
│   │   └── style.css        # 全局样式
│   ├── package.json
│   └── vite.config.js
└── backend/                 # 后端项目 (FastAPI + SQLAlchemy)
    ├── main.py              # 主应用入口
    ├── api/                 # API路由
    │   ├── competition.py   # 赛事相关API
    │   ├── admin.py         # 管理后台API
    │   └── crawl.py         # 爬虫相关API
    ├── models/              # 数据库模型
    │   └── competition.py   # 赛事模型
    ├── schemas/             # 数据验证模式
    │   └── competition.py   # 赛事模式
    ├── database.py          # 数据库配置
    └── requirements.txt    # Python依赖
```

## 功能特性

### 前端功能
- **首页展示**：最新赛事、赛事分类、统计数据展示
- **赛事浏览**：列表展示、分类筛选、搜索功能
- **赛事详情**：完整赛事信息展示、报名功能
- **管理后台**：用户认证、赛事管理、爬虫控制
- **响应式设计**：适配PC和移动端

### 后端功能
- **RESTful API**：标准化接口设计
- **数据库管理**：ORM模型、事务处理
- **爬虫系统**：自动化赛事信息采集
- **定时任务**：定时爬取和数据更新
- **用户认证**：Token验证、权限控制

### 数据源支持
- 教育部官网
- 创新大赛平台
- 竞赛管家平台
- 支持扩展更多数据源

## 快速开始

### 环境要求
- Node.js >= 16
- Python >= 3.8

### 后端启动

1. 进入后端目录
```bash
cd backend
```

2. 安装依赖
```bash
pip install -r requirements.txt
```

3. 启动服务
```bash
python main.py
```

后端将在 http://localhost:8000 启动

### 前端启动

1. 进入前端目录
```bash
cd frontend
```

2. 安装依赖
```bash
npm install
```

3. 启动开发服务器
```bash
npm run dev
```

前端将在 http://localhost:5173 启动

## 技术栈

### 前端
- Vue 3.4+
- Element Plus 2.5+
- Vue Router 4.2+
- Pinia 2.1+
- Axios 1.6+

### 后端
- FastAPI 0.104+
- SQLAlchemy 2.0+
- Pydantic 2.5+
- BeautifulSoup4
- Requests
- APScheduler

## 核心模块

### 赛事管理
- 赛事信息的CRUD操作
- 分类和状态管理
- 搜索和筛选功能
- 报名人数统计

### 爬虫系统
- 多平台数据采集
- 定时任务调度
- 数据清洗和解析
- 错误重试机制

### 用户管理
- 管理员认证
- 权限控制
- 会话管理
- 密码安全

## 开发说明

### 代码规范
- 使用ESLint + Prettier保持代码风格一致
- Vue组件使用Composition API
- 遵循RESTful API设计原则

### 数据库设计
- 使用SQLAlchemy ORM
- 支持SQLite和PostgreSQL
- 自动迁移机制

### 配置管理
- 环境变量配置
- 敏感信息存储
- 开发/生产环境分离

## 未来规划

- [ ] 添加更多数据源
- [ ] 实现用户注册和报名
- [ ] 添加评论和评分功能
- [ ] 优化爬虫性能
- [ ] 添加数据可视化
- [ ] 实现移动端应用

## 版本历史

- v1.0.0 - 重构版本，完成基础框架搭建

## 许可证

MIT License