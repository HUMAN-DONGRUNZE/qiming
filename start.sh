#!/bin/bash

# 青少年赛事信息聚合平台启动脚本

echo "🚀 青少年赛事信息聚合平台启动中..."

# 检查Python环境
if ! command -v python3 &> /dev/null; then
    echo "❌ 未找到Python3，请先安装Python 3.8或更高版本"
    exit 1
fi

# 检查Node.js环境
if ! command -v node &> /dev/null; then
    echo "❌ 未找到Node.js，请先安装Node.js 16或更高版本"
    exit 1
fi

# 检查npm环境
if ! command -v npm &> /dev/null; then
    echo "❌ 未找到npm，请先安装npm"
    exit 1
fi

echo "✅ 环境检查通过"

# 创建数据库
echo "📦 正在初始化数据库..."
cd backend
python3 -c "
from database import init_db
init_db()
"
echo "✅ 数据库初始化完成"

# 安装后端依赖
echo "📦 正在安装后端依赖..."
pip install -r requirements.txt

# 启动后端服务
echo "🔧 启动后端服务..."
python3 main.py &
BACKEND_PID=$!

# 等待后端启动
echo "⏳ 等待后端服务启动..."
sleep 5

# 安装前端依赖
cd ../frontend
echo "📦 正在安装前端依赖..."
npm install

# 启动前端服务
echo "🎨 启动前端服务..."
npm run dev &
FRONTEND_PID=$!

# 等待前端启动
echo "⏳ 等待前端服务启动..."
sleep 5

echo "✅ 平台启动完成！"
echo ""
echo "📱 前端地址: http://localhost:5173"
echo "🔧 后端地址: http://localhost:8000"
echo "📖 API文档: http://localhost:8000/docs"
echo ""
echo "按 Ctrl+C 停止服务"

# 等待用户中断
trap "echo '🛑 正在停止服务...'; kill $BACKEND_PID $FRONTEND_PID; exit" INT
wait