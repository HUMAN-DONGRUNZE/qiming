from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

# 应用生命周期管理
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时执行
    print("🚀 青少年赛事信息聚合平台启动中...")
    yield
    # 关闭时执行
    print("👋 平台正在关闭...")

app = FastAPI(
    title="青少年赛事信息聚合平台 API",
    description="提供赛事信息管理、爬虫控制等API接口",
    version="1.0.0",
    lifespan=lifespan
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 健康检查
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "message": "赛事聚合平台运行正常"
    }

# 主应用将在这里注册路由
from api.competition import router as competition_router
from api.admin import router as admin_router
from api.crawl import router as crawl_router

app.include_router(competition_router, prefix="/api/competitions", tags=["赛事"])
app.include_router(admin_router, prefix="/api/admin", tags=["管理"])
app.include_router(crawl_router, prefix="/api/crawl", tags=["爬虫"])

# 启动任务处理器
from api.crawl import startup_task

@app.on_event("startup")
async def startup_event():
    await startup_task()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
